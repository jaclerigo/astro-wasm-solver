<?php
/**
 * Plugin Name:       Astro WASM Plate Solver
 * Plugin URI:        https://github.com/jaclerigo/astro-wasm-solver
 * Description:       Plate Solving local via WebAssembly na Biblioteca Multimédia e overlays interativos (Pan & Zoom) no frontend.
 * Version:           1.0.0
 * Author:            João Clérigo
 * Text Domain:       astro-wasm-solver
 * Domain Path:       /languages
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Segurança contra acesso direto
}

// Constantes do Plugin
define( 'AWS_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'AWS_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

// 1. Carregar Assets na Administração (wp-admin/upload.php)
function aws_enqueue_admin_scripts( $hook ) {
    if ( $hook !== 'upload.php' && $hook !== 'post.php' ) return;

    wp_enqueue_script(
        'aws-admin-solver',
        AWS_PLUGIN_URL . 'js/admin-solver.js',
        array( 'jquery' ),
        '1.0.0',
        true
    );
    wp_enqueue_style(
        'aws-admin-solver',
        AWS_PLUGIN_URL . 'css/admin-solver.css',
        array(),
        '1.0.0'
    );

    wp_localize_script( 'aws-admin-solver', 'AWS_Settings', array(
        'plugin_url'   => AWS_PLUGIN_URL,
        'ajax_url'     => admin_url( 'admin-ajax.php' ),
        'nonce'        => wp_create_nonce( 'aws_save_solving_nonce' ),
        'index_url'          => AWS_PLUGIN_URL . 'catalogs/zodiacal-index.zdcl',
        'object_catalog_url' => AWS_PLUGIN_URL . 'catalogs/openngc.json'
    ) );
}
add_action( 'admin_enqueue_scripts', 'aws_enqueue_admin_scripts' );

// 2. Carregar Assets no Frontend
function aws_enqueue_frontend_scripts() {
    if ( is_admin() ) return;

    // Panzoom Library
    wp_enqueue_script(
        'panzoom',
        'https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.5.1/dist/panzoom.min.js',
        array(),
        '4.5.1',
        true
    );

    wp_enqueue_script(
        'aws-frontend-overlay',
        AWS_PLUGIN_URL . 'js/frontend-overlay.js',
        array( 'panzoom' ),
        '1.0.0',
        true
    );

    wp_enqueue_style(
        'aws-frontend-style',
        AWS_PLUGIN_URL . 'css/frontend-overlay.css',
        array(),
        '1.0.0'
    );
}
add_action( 'wp_enqueue_scripts', 'aws_enqueue_frontend_scripts' );

// 3. Adicionar Botão no Modal de Detalhes da Imagem (upload.php)
function aws_add_media_fields( $form_fields, $post ) {
    if ( ! wp_attachment_is_image( $post->ID ) ) return $form_fields;

    $solved  = get_post_meta( $post->ID, '_astro_plate_solved', true );
    $ra      = get_post_meta( $post->ID, '_astro_ra', true );
    $dec     = get_post_meta( $post->ID, '_astro_dec', true );

    $status  = $solved 
        ? '<span style="color:#22c55e; font-weight:600;">✓ Resolvido</span> (' . esc_html("$ra, $dec") . ')'
        : '<span style="color:#9ca3af;">Não resolvido</span>';

    $img_url = wp_get_attachment_image_url( $post->ID, 'full' );

    $form_fields['astro_plate_solver'] = array(
        'label' => 'Astro Plate Solving',
        'input' => 'html',
        'html'  => '
            <div class="aws-admin-box" style="margin-top:6px;">
                <p style="margin:0 0 8px;">Estado: ' . $status . '</p>
                <button type="button" class="button button-secondary aws-run-wasm-solver-btn" 
                        data-attachment-id="' . $post->ID . '" 
                        data-image-url="' . esc_url( $img_url ) . '">
                    ⚡ ' . ( $solved ? 'Re-executar Plate Solving (WASM)' : 'Executar Plate Solving (WASM)' ) . '
                </button>
            </div>
        ',
    );

    return $form_fields;
}
add_filter( 'attachment_fields_to_edit', 'aws_add_media_fields', 10, 2 );

// 4. Endpoint AJAX para guardar a Solução WCS no wp_postmeta
function aws_save_solving_data() {
    check_ajax_referer( 'aws_save_solving_nonce', 'nonce' );

    $attachment_id = isset( $_POST['attachment_id'] ) ? intval( $_POST['attachment_id'] ) : 0;

    if (
        $attachment_id <= 0 ||
        ! current_user_can( 'edit_post', $attachment_id ) ||
        ! wp_attachment_is_image( $attachment_id )
    ) {
        wp_send_json_error( array( 'message' => 'Não tem permissão para atualizar este anexo.' ), 403 );
    }

    $required_fields = array( 'ra', 'dec', 'scale', 'rotation', 'objects', 'wcs' );
    foreach ( $required_fields as $field ) {
        if ( ! isset( $_POST[ $field ] ) || ! is_scalar( $_POST[ $field ] ) ) {
            wp_send_json_error( array( 'message' => 'A solução enviada está incompleta.' ), 400 );
        }
    }

    foreach ( array( 'ra', 'dec', 'scale', 'rotation' ) as $field ) {
        if ( ! is_numeric( wp_unslash( $_POST[ $field ] ) ) ) {
            wp_send_json_error( array( 'message' => 'As coordenadas ou a escala da solução são inválidas.' ), 400 );
        }
    }

    $ra       = (float) wp_unslash( $_POST['ra'] );
    $dec      = (float) wp_unslash( $_POST['dec'] );
    $scale    = (float) wp_unslash( $_POST['scale'] );
    $rotation = (float) wp_unslash( $_POST['rotation'] );
    if (
        ! is_finite( $ra ) ||
        ! is_finite( $dec ) ||
        ! is_finite( $scale ) ||
        ! is_finite( $rotation ) ||
        $ra < 0 ||
        $ra >= 360 ||
        $dec < -90 ||
        $dec > 90 ||
        $scale <= 0
    ) {
        wp_send_json_error( array( 'message' => 'As coordenadas ou a escala da solução são inválidas.' ), 400 );
    }

    $objects = json_decode( wp_unslash( $_POST['objects'] ), true );
    $wcs     = json_decode( wp_unslash( $_POST['wcs'] ), true );
    if (
        ! is_array( $objects ) ||
        ! is_array( $wcs ) ||
        ! isset( $wcs['crval'], $wcs['crpix'], $wcs['cd'] ) ||
        ! is_array( $wcs['crval'] ) ||
        count( $wcs['crval'] ) !== 2 ||
        ! is_array( $wcs['crpix'] ) ||
        count( $wcs['crpix'] ) !== 2 ||
        ! is_array( $wcs['cd'] ) ||
        count( $wcs['cd'] ) !== 2 ||
        ! is_array( $wcs['cd'][0] ) ||
        count( $wcs['cd'][0] ) !== 2 ||
        ! is_array( $wcs['cd'][1] ) ||
        count( $wcs['cd'][1] ) !== 2
    ) {
        wp_send_json_error( array( 'message' => 'Os metadados WCS ou o catálogo de objetos são inválidos.' ), 400 );
    }

    $wcs_values = array_merge(
        $wcs['crval'],
        $wcs['crpix'],
        $wcs['cd'][0],
        $wcs['cd'][1]
    );
    foreach ( $wcs_values as $value ) {
        if ( ! is_numeric( $value ) || ! is_finite( (float) $value ) ) {
            wp_send_json_error( array( 'message' => 'Os metadados WCS contêm valores inválidos.' ), 400 );
        }
    }

    foreach ( $objects as $object ) {
        if (
            ! is_array( $object ) ||
            ! isset( $object['name'], $object['x'], $object['y'] ) ||
            ! is_string( $object['name'] ) ||
            ! is_numeric( $object['x'] ) ||
            ! is_numeric( $object['y'] ) ||
            ! is_finite( (float) $object['x'] ) ||
            ! is_finite( (float) $object['y'] )
        ) {
            wp_send_json_error( array( 'message' => 'O catálogo de objetos contém registos inválidos.' ), 400 );
        }
    }

    update_post_meta( $attachment_id, '_astro_plate_solved', 1 );
    update_post_meta( $attachment_id, '_astro_ra', (string) $ra );
    update_post_meta( $attachment_id, '_astro_dec', (string) $dec );
    update_post_meta( $attachment_id, '_astro_scale', (string) $scale );
    update_post_meta( $attachment_id, '_astro_rotation', (string) $rotation );
    update_post_meta( $attachment_id, '_astro_objects', wp_json_encode( $objects ) );
    update_post_meta( $attachment_id, '_astro_wcs', wp_json_encode( $wcs ) );

    wp_send_json_success( array( 'message' => 'Guardado com sucesso!' ) );
}
add_action( 'wp_ajax_aws_save_solving', 'aws_save_solving_data' );

// 5. Filtro para envolver imagens com Plate Solving no Viewer Interativo
function aws_render_interactive_media( $html, $attachment_id ) {
    if ( is_admin() ) return $html;

    $solved  = get_post_meta( $attachment_id, '_astro_plate_solved', true );
    $objects = get_post_meta( $attachment_id, '_astro_objects', true );

    if ( ! $solved || empty( $objects ) ) return $html;

    $image_html = preg_replace_callback(
        '/<img\b[^>]*>/i',
        static function( $matches ) {
            $image_tag = $matches[0];

            if ( preg_match( '/\bclass\s*=\s*(["\'])(.*?)\1/i', $image_tag, $class_match, PREG_OFFSET_CAPTURE ) ) {
                $classes = preg_split( '/\s+/', trim( $class_match[2][0] ), -1, PREG_SPLIT_NO_EMPTY );
                if ( ! in_array( 'astro-base-img', $classes, true ) ) {
                    $classes[] = 'astro-base-img';
                }

                return substr_replace(
                    $image_tag,
                    'class="' . esc_attr( implode( ' ', $classes ) ) . '"',
                    $class_match[0][1],
                    strlen( $class_match[0][0] )
                );
            }

            return preg_replace( '/<img\b/i', '<img class="astro-base-img"', $image_tag, 1 );
        },
        $html,
        1
    );

    if ( ! is_string( $image_html ) ) return $html;

    $output  = '<div class="astro-viewer-container" data-astro-objects="' . esc_attr( $objects ) . '">';
    $output .= '  <div class="astro-panzoom-target">';
    $output .=      $image_html;
    $output .= '    <svg class="astro-overlay-svg"></svg>';
    $output .= '  </div>';
    $output .= '  <div class="astro-tooltip"></div>';
    $output .= '  <div class="astro-controls-bar">';
    $output .= '    <button type="button" class="astro-btn btn-zoom-in" title="Aumentar">+</button>';
    $output .= '    <button type="button" class="astro-btn btn-zoom-out" title="Diminuir">−</button>';
    $output .= '    <button type="button" class="astro-btn btn-reset" title="Centrar">⟲</button>';
    $output .= '    <button type="button" class="astro-btn btn-toggle-labels" title="Anotações">👁️</button>';
    $output .= '  </div>';
    $output .= '</div>';

    return $output;
}
add_filter( 'wp_get_attachment_image', 'aws_render_interactive_media', 10, 2 );

function aws_render_interactive_content_images( $content ) {
    if ( is_admin() || ! is_string( $content ) ) {
        return $content;
    }

    return preg_replace_callback(
        '/<img\b[^>]*>/i',
        static function( $matches ) {
            $image_tag = $matches[0];
            if (
                preg_match( '/\bclass\s*=\s*(["\'])(.*?)\1/i', $image_tag, $class_match ) &&
                preg_match( '/(?:^|\s)astro-base-img(?:\s|$)/', $class_match[2] )
            ) {
                return $image_tag;
            }

            if ( ! preg_match( '/(?:^|\s)wp-image-(\d+)(?:\s|$)/', $image_tag, $attachment_match ) ) {
                return $image_tag;
            }

            return aws_render_interactive_media( $image_tag, (int) $attachment_match[1] );
        },
        $content
    );
}
add_filter( 'the_content', 'aws_render_interactive_content_images', 11 );