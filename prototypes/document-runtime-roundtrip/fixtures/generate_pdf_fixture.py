#!/usr/bin/env python3

from pathlib import Path

from reportlab import rl_config
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


OUTPUT = Path(__file__).with_name("pdf-operations-brief.pdf")
rl_config.invariant = 1


def footer(canvas, document):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#666666"))
    canvas.drawString(20 * mm, 12 * mm, "ScopeGuard synthetic PDF fixture")
    canvas.drawRightString(190 * mm, 12 * mm, f"Page {document.page}")
    canvas.restoreState()


def build():
    styles = getSampleStyleSheet()
    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=22 * mm,
        title="ScopeGuard PDF Runtime Fixture",
        author="ScopeGuard prototype",
        subject="Synthetic fixture for page operations and render comparison",
    )

    rows = [
        ["Operation", "Expected behavior", "Risk"],
        ["Inspect", "Keep page order and metadata", "Low"],
        ["Rotate", "Rotate only the selected page", "Medium"],
        ["Merge", "Preserve source page content", "Medium"],
        ["Split", "Expose document-level losses", "High"],
    ]
    table = Table(rows, colWidths=[35 * mm, 95 * mm, 25 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#222222")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#999999")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")]),
            ]
        )
    )

    story = [
        Paragraph("ScopeGuard PDF Runtime Fixture", styles["Title"]),
        Spacer(1, 8 * mm),
        Paragraph(
            "This file contains ordinary text, a repeated table header, metadata, "
            "three pages, and stable page labels. It contains no company data.",
            styles["BodyText"],
        ),
        Spacer(1, 8 * mm),
        table,
        PageBreak(),
        Paragraph("Page Two: Rotation Target", styles["Heading1"]),
        Spacer(1, 6 * mm),
        Paragraph(
            "The prototype rotates this page by 90 degrees while preserving the "
            "source file. A separate pass-through output must render identically.",
            styles["BodyText"],
        ),
        PageBreak(),
        Paragraph("Page Three: Assembly Target", styles["Heading1"]),
        Spacer(1, 6 * mm),
        Paragraph(
            "This final page verifies page count, ordering, and deterministic raster "
            "output after a content-preserving qpdf rewrite.",
            styles["BodyText"],
        ),
    ]
    document.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    build()
