#!/usr/bin/env python3
"""Render PDF pages deterministically for the round-trip visual comparison."""

from __future__ import annotations

import argparse
from pathlib import Path

import pymupdf


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-prefix", required=True, type=Path)
    args = parser.parse_args()

    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    scale = 150 / 72
    matrix = pymupdf.Matrix(scale, scale)

    with pymupdf.open(args.input) as document:
        if document.page_count == 0:
            raise RuntimeError(f"PDF has no pages: {args.input}")
        for index, page in enumerate(document, start=1):
            pixmap = page.get_pixmap(matrix=matrix, alpha=False, colorspace=pymupdf.csRGB)
            pixmap.save(f"{args.output_prefix}-{index}.png")


if __name__ == "__main__":
    main()
