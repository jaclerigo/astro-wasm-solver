#!/usr/bin/env python3
"""Export the star trees in Astrometry.net index FITS files as Zodiacal records."""

import argparse
import math
import re
import struct
import subprocess
import tempfile
from pathlib import Path


FITS_BLOCK_SIZE = 2880
STAR_EXTENSIONS = {
    "kdtree_header_stars",
    "kdtree_lr_stars",
    "kdtree_split_stars",
    "kdtree_range_stars",
    "kdtree_data_stars",
    "sweep",
    "j_mag",
}
NUMERIC_FORMATS = {
    "B": (">B", 1),
    "I": (">h", 2),
    "J": (">i", 4),
    "K": (">q", 8),
    "E": (">f", 4),
    "D": (">d", 8),
}


def parse_card_value(card):
    value = card[10:].strip()
    if value.startswith("'"):
        return value[1 : value.find("'", 1)].strip()
    return value.split("/", 1)[0].strip()


def read_hdus(path):
    with path.open("rb") as source:
        extension = 0
        while True:
            first_block = source.read(FITS_BLOCK_SIZE)
            if not first_block:
                return
            if len(first_block) != FITS_BLOCK_SIZE:
                raise ValueError(f"Truncated FITS header in {path}")

            header_blocks = [first_block]
            cards = []
            while True:
                block = header_blocks[-1]
                cards.extend(
                    block[offset : offset + 80].decode("ascii")
                    for offset in range(0, FITS_BLOCK_SIZE, 80)
                )
                if any(card.startswith("END ") for card in cards):
                    break
                block = source.read(FITS_BLOCK_SIZE)
                if len(block) != FITS_BLOCK_SIZE:
                    raise ValueError(f"Truncated FITS header in {path}")
                header_blocks.append(block)

            header = {
                card[:8].strip(): parse_card_value(card)
                for card in cards
                if card[8:10] == "= "
            }
            axes = int(header.get("NAXIS", "0"))
            elements = (
                math.prod(int(header[f"NAXIS{axis}"]) for axis in range(1, axes + 1))
                if axes
                else 0
            )
            bitpix = abs(int(header.get("BITPIX", "8")))
            data_size = elements * (bitpix // 8) + int(header.get("PCOUNT", "0"))
            data_size *= int(header.get("GCOUNT", "1"))
            data = source.read(data_size)
            padding = (-data_size) % FITS_BLOCK_SIZE
            pad = source.read(padding)
            if len(data) != data_size or len(pad) != padding:
                raise ValueError(f"Truncated FITS data in {path}")

            raw_hdu = b"".join(header_blocks) + data + pad
            yield extension, header, data, raw_hdu
            extension += 1


def write_star_tree(index_path, target):
    included = 0
    with target.open("wb") as output:
        for extension, header, _, raw_hdu in read_hdus(index_path):
            name = header.get("TTYPE1", "").strip().lower()
            if extension == 0 or name in STAR_EXTENSIONS:
                output.write(raw_hdu)
                included += extension != 0
    if included != len(STAR_EXTENSIONS):
        raise ValueError(f"{index_path} does not contain a complete star tree")


def read_star_table(path):
    for _, header, data, _ in read_hdus(path):
        if header.get("XTENSION", "").strip().upper() != "BINTABLE":
            continue

        columns = {}
        offset = 0
        for number in range(1, int(header["TFIELDS"]) + 1):
            name = header[f"TTYPE{number}"].strip().upper()
            form = header[f"TFORM{number}"].strip().upper()
            match = re.fullmatch(r"(\d*)([A-Z])", form)
            if not match:
                raise ValueError(f"Unsupported FITS column format {form}")
            repeat = int(match.group(1) or "1")
            code = match.group(2)
            if code not in NUMERIC_FORMATS:
                raise ValueError(f"Unsupported FITS column type {code}")
            value_format, value_size = NUMERIC_FORMATS[code]
            columns[name] = (offset, value_format, repeat, value_size)
            offset += repeat * value_size

        required = {"RA", "DEC", "J_MAG"}
        if not required.issubset(columns):
            raise ValueError(f"Star table is missing columns: {required - columns.keys()}")

        row_size = int(header["NAXIS1"])
        for row in range(int(header["NAXIS2"])):
            values = []
            for name in ("RA", "DEC", "J_MAG"):
                column_offset, value_format, repeat, value_size = columns[name]
                if repeat != 1:
                    raise ValueError(f"Expected scalar star-table column {name}")
                values.append(struct.unpack_from(value_format, data, row * row_size + column_offset)[0])
            yield values[0], values[1], values[2]
        return
    raise ValueError(f"No binary star table found in {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("indexes", nargs="+", type=Path, help="Astrometry.net index FITS files")
    parser.add_argument("--query-starkd", default="query-starkd", help="Astrometry.net query-starkd executable")
    parser.add_argument("--output", type=Path, default=Path("catalogs/zodiacal-stars.bin"))
    args = parser.parse_args()

    stars = {}
    queried_count = 0
    with tempfile.TemporaryDirectory(prefix="aws-zodiacal-") as temporary:
        temporary_path = Path(temporary)
        for index_number, index_path in enumerate(args.indexes):
            tree_path = temporary_path / f"stars-{index_number}.fits"
            table_path = temporary_path / f"catalog-{index_number}.fits"
            write_star_tree(index_path, tree_path)
            subprocess.run(
                [
                    args.query_starkd,
                    "-T",
                    "-r",
                    "0",
                    "-d",
                    "0",
                    "-R",
                    "180",
                    "-o",
                    str(table_path),
                    str(tree_path),
                ],
                check=True,
            )

            for ra_deg, dec_deg, magnitude in read_star_table(table_path):
                queried_count += 1
                ra_deg %= 360.0
                if not all(map(math.isfinite, (ra_deg, dec_deg, magnitude))):
                    continue
                if not -90.0 <= dec_deg <= 90.0:
                    continue

                key = (round(ra_deg, 6), round(dec_deg, 6))
                current = stars.get(key)
                if current is None or magnitude < current[2]:
                    stars[key] = (ra_deg, dec_deg, magnitude)

    if len(stars) >= 2**24:
        raise ValueError("The Float32 catalog format supports fewer than 16,777,216 stars")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary_output.open("wb") as output:
        for identifier, (ra_deg, dec_deg, magnitude) in enumerate(
            sorted(stars.values(), key=lambda star: (star[0], star[1]))
        ):
            output.write(
                struct.pack(
                    "<ffff",
                    identifier,
                    math.radians(ra_deg),
                    math.radians(dec_deg),
                    magnitude,
                )
            )
    temporary_output.replace(args.output)
    print(
        f"Exported {len(stars):,} unique stars from {queried_count:,} rows "
        f"to {args.output} ({args.output.stat().st_size:,} bytes)."
    )


if __name__ == "__main__":
    main()
