#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-prefix", required=True)
    parser.add_argument("--after-prefix", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-changed-ratio", type=float, required=True)
    parser.add_argument("--require-change", action="store_true")
    return parser.parse_args()


def page_files(prefix_value):
    prefix = Path(prefix_value)
    return sorted(
        prefix.parent.glob(f"{prefix.name}-*.png"),
        key=lambda path: int(path.stem.rsplit("-", 1)[-1]),
    )


def compare_page(before_path, after_path):
    with Image.open(before_path) as before_image, Image.open(after_path) as after_image:
        before = before_image.convert("RGB")
        after = after_image.convert("RGB")
        if before.size != after.size:
            return {
                "before": before_path.name,
                "after": after_path.name,
                "sameDimensions": False,
                "width": before.width,
                "height": before.height,
                "changedPixels": before.width * before.height,
                "changedPixelRatio": 1.0,
                "meanAbsoluteError": 1.0,
                "changeBounds": None,
            }

        difference = ImageChops.difference(before, after)
        channels = difference.split()
        thresholded = [
            channel.point(lambda value: 255 if value > 8 else 0)
            for channel in channels
        ]
        mask = ImageChops.lighter(
            ImageChops.lighter(thresholded[0], thresholded[1]),
            thresholded[2],
        )
        changed_pixels = mask.histogram()[255]
        absolute_error = sum(
            value * count
            for channel in channels
            for value, count in enumerate(channel.histogram())
        )
        pixel_count = before.width * before.height
        raw_bounds = mask.getbbox()
        bounds = None if raw_bounds is None else {
            "left": raw_bounds[0],
            "top": raw_bounds[1],
            "right": raw_bounds[2] - 1,
            "bottom": raw_bounds[3] - 1,
        }
        return {
            "before": before_path.name,
            "after": after_path.name,
            "sameDimensions": True,
            "width": before.width,
            "height": before.height,
            "changedPixels": changed_pixels,
            "changedPixelRatio": changed_pixels / pixel_count,
            "meanAbsoluteError": absolute_error / (pixel_count * 3 * 255),
            "changeBounds": bounds,
        }


def main():
    args = parse_args()
    before_pages = page_files(args.before_prefix)
    after_pages = page_files(args.after_prefix)
    page_count_matches = len(before_pages) == len(after_pages) and bool(before_pages)
    pages = [
        compare_page(before, after)
        for before, after in zip(before_pages, after_pages)
    ]
    dimensions_match = page_count_matches and all(page["sameDimensions"] for page in pages)
    changed_pixels = sum(page["changedPixels"] for page in pages)
    total_pixels = sum(page["width"] * page["height"] for page in pages)
    changed_ratio = changed_pixels / total_pixels if total_pixels else 1.0
    change_requirement_met = changed_pixels > 0 if args.require_change else True
    passed = (
        page_count_matches
        and dimensions_match
        and changed_ratio <= args.max_changed_ratio
        and change_requirement_met
    )
    report = {
        "beforePageCount": len(before_pages),
        "afterPageCount": len(after_pages),
        "pageCountMatches": page_count_matches,
        "dimensionsMatch": dimensions_match,
        "changedPixels": changed_pixels,
        "changedPixelRatio": changed_ratio,
        "maxChangedPixelRatio": args.max_changed_ratio,
        "requiredVisibleChange": args.require_change,
        "visibleChangeFound": changed_pixels > 0,
        "pages": pages,
        "passed": passed,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
