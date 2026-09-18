"""Shared minimal OOXML (.docx) builder helpers, using only the Python standard library
(zipfile) - a .docx is just a zip of XML parts, no third-party package needed. Used by every
one-off report generator script in this folder so the OOXML plumbing only has to be right
in one place.
"""
import zipfile
from datetime import date


def esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def run(text, bold=False, sz=None, color=None, italic=False):
    props = ""
    if bold or sz or color or italic:
        parts = []
        if bold:
            parts.append("<w:b/>")
        if italic:
            parts.append("<w:i/>")
        if color:
            parts.append(f'<w:color w:val="{color}"/>')
        if sz:
            parts.append(f'<w:sz w:val="{sz}"/>')
        props = f"<w:rPr>{''.join(parts)}</w:rPr>"
    return f'<w:r>{props}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'


def para(runs, spacing_after=160, indent=None):
    if isinstance(runs, str):
        runs = [run(runs)]
    ind = f'<w:ind w:left="{indent}"/>' if indent else ""
    return f'<w:p><w:pPr><w:spacing w:after="{spacing_after}"/>{ind}</w:pPr>{"".join(runs)}</w:p>'


def heading(text, level=1):
    sz = {1: "32", 2: "26", 3: "22"}.get(level, "22")
    return f'<w:p><w:pPr><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="{level-1}"/></w:pPr>{run(text, bold=True, sz=sz, color="1F4E78")}</w:p>'


def bullet(text, indent=360):
    return para([run("•  "), run(text)], indent=indent)


def cell(text, width, header=False, shade=None):
    shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>' if shade else ""
    # White text on the dark header fill so it's actually legible - plain bold-on-dark-blue
    # reads as barely-visible dark-on-dark otherwise.
    r = run(text, bold=header, color="FFFFFF" if header else None)
    return (
        f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{shd}'
        f'<w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/>'
        f'<w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>'
        f'<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{r}</w:p></w:tc>'
    )


def table(headers, rows, widths, header_shade="1F4E78"):
    tbl_borders = (
        '<w:tblBorders>'
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
        '</w:tblBorders>'
    )
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    head_row = "<w:tr>" + "".join(cell(h, w, header=True, shade=header_shade) for h, w in zip(headers, widths)) + "</w:tr>"
    body_rows = ""
    for row in rows:
        body_rows += "<w:tr>" + "".join(cell(v, w) for v, w in zip(row, widths)) + "</w:tr>"
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>{tbl_borders}</w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>{head_row}{body_rows}</w:tbl>'
        f'<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>'
    )


def write_docx(out_path, title, body_parts):
    """Assembles the full OOXML part set and writes the .docx file."""
    today = date.today().isoformat()

    document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
{''.join(body_parts)}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>'''

    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

    core_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>{esc(title)}</dc:title>
<dc:creator>TnT QA</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">{today}T00:00:00Z</dcterms:created>
</cp:coreProperties>'''

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("docProps/core.xml", core_xml)
        z.writestr("word/document.xml", document_xml)

    return today
