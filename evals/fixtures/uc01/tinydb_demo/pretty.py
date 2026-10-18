def render_table(rows):
    headers = list(rows[0])
    widths = [len(header) for header in headers]
    return '  '.join(_pad_header(header, width) for header, width in zip(headers, widths))


def _pad_header(header, width):
    return header.ljust(width)
