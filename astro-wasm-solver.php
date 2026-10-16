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

    wp_localize_script( 'aws-admin-solver', 'AWS_Settings', array(
        'plugin_url'   => AWS_PLUGIN_URL,
        'ajax_url'     => admin_url( 'admin-ajax.php' ),
        'nonce'        => wp_create_nonce( 'aws_save_solving_nonce' ),
        'catalogs'     => array(
            AWS_PLUGIN_URL . 'catalogs/index-4209.fits',
            AWS_PLUGIN_URL . 'catalogs/index-4210.fits',
            AWS_PLUGIN_URL . 'catalogs/index-4211.fits'
        )
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

    if ( $attachment_id > 0 ) {
        update_post_meta( $attachment_id, '_astro_plate_solved', 1 );
        update_post_meta( $attachment_id, '_astro_ra', sanitize_text_field( $_POST['ra'] ) );
        update_post_meta( $attachment_id, '_astro_dec', sanitize_text_field( $_POST['dec'] ) );
        update_post_meta( $attachment_id, '_astro_scale', sanitize_text_field( $_POST['scale'] ) );
        update_post_meta( $attachment_id, '_astro_rotation', sanitize_text_field( $_POST['rotation'] ) );
        update_post_meta( $attachment_id, '_astro_objects', wp_unslash( $_POST['objects'] ) );

        wp_send_json_success( array( 'message' => 'Guardado com sucesso!' ) );
    }

    wp_send_json_error( array( 'message' => 'Falha ao guardar os metadados.' ) );
}
add_action( 'wp_ajax_aws_save_solving', 'aws_save_solving_data' );

// 5. Filtro para envolver imagens com Plate Solving no Viewer Interativo
function aws_render_interactive_media( $html, $attachment_id ) {
    if ( is_admin() ) return $html;

    $solved  = get_post_meta( $attachment_id, '_astro_plate_solved', true );
    $objects = get_post_meta( $attachment_id, '_astro_objects', true );

    if ( ! $solved || empty( $objects ) ) return $html;

    $output  = '<div class="astro-viewer-container" data-astro-objects="' . esc_attr( $objects ) . '">';
    $output .= '  <div class="astro-panzoom-target">';
    $output .=      $html; // <img> original
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