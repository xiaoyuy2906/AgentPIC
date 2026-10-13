from pathlib import Path


def write_preview(directory: Path, metadata: dict) -> None:
    """Static vector preview derived from exported GDS, without a GUI."""
    import klayout.db as kdb

    layout = kdb.Layout()
    layout.read(str(directory / "design.gds"))
    top = layout.top_cell()
    region = kdb.Region(top.begin_shapes_rec(layout.find_layer(*metadata["core_layer"])))
    bbox = region.bbox()
    x, y = bbox.left * layout.dbu - 10, -bbox.top * layout.dbu - 10
    width, height = bbox.width() * layout.dbu + 20, bbox.height() * layout.dbu + 20
    elements = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {width} {height}">',
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="#f8fafc"/>',
        '<g fill="#2563eb" fill-rule="evenodd">',
    ]
    for polygon in region.each():
        rings = [list(polygon.each_point_hull())] + [
            list(polygon.each_point_hole(i)) for i in range(polygon.holes())
        ]
        commands = []
        for ring in rings:
            commands.append(
                "M "
                + " L ".join(f"{p.x * layout.dbu:.3f},{-p.y * layout.dbu:.3f}" for p in ring)
                + " Z"
            )
        elements.append(f'<path d="{" ".join(commands)}"/>')
    elements.extend(["</g>", "</svg>"])
    (directory / "layout.svg").write_text("\n".join(elements))
