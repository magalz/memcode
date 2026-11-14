import sys
from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
output=Path(sys.argv[1])
doc=Document()
section=doc.sections[0]
section.top_margin=Inches(.8);section.bottom_margin=Inches(.75)
section.left_margin=Inches(.85);section.right_margin=Inches(.85)
for name in ["Normal","Title","Heading 1","Heading 2"]:
    style=doc.styles[name];style.font.name="Arial";style.font.color.rgb=RGBColor(0,0,0)
doc.styles["Normal"].font.size=Pt(11)
doc.styles["Normal"].paragraph_format.space_after=Pt(10)
doc.styles["Title"].font.size=Pt(30)
doc.styles["Heading 1"].font.size=Pt(17)
header=section.header.paragraphs[0]
header.text="ATELIER   /   CREATIVE DIRECTION";header.runs[0].font.size=Pt(9)
header.runs[0].font.color.rgb=RGBColor.from_string("647C6A")
doc.add_paragraph("Atelier creative brief",style="Title")
doc.add_paragraph("A shared studio for the person and the worker")
doc.add_paragraph("This local demo pairs an interactive creative studio with a live browser, a persistent terminal and saved outputs. The person can explore the same page the worker is using and open finished work directly from the card.")
doc.add_heading("What the studio should feel like",level=1)
doc.add_paragraph("Calm, tactile and precise. Warm paper gives the work room to breathe; dark green anchors the controls. Colour choices and material studies should be visible immediately, with clear feedback after every interaction.")
doc.add_heading("Deliverables",level=1)
table=doc.add_table(rows=1,cols=3)
headers=["Output","Purpose","Interaction"]
for c,value in zip(table.rows[0].cells,headers):c.text=value
for values in [("Live studio","Explore the working design","Shared browser"),("Editorial poster","Review the visual direction","Direct image preview"),("Creative brief","Keep the rationale with the work","Rendered Word pages")]:
    for cell,value in zip(table.add_row().cells,values):cell.text=value
for index,row in enumerate(table.rows):
    for cell in row.cells:
        props=cell._tc.get_or_add_tcPr();shade=OxmlElement("w:shd");shade.set(qn("w:fill"),"1A2F24" if index==0 else "F1F5EE" if index%2 else "FFFFFF");props.append(shade)
        borders=OxmlElement("w:tcBorders")
        for edge in ["top","left","bottom","right"]:
            item=OxmlElement("w:"+edge);item.set(qn("w:val"),"single");item.set(qn("w:sz"),"4");item.set(qn("w:color"),"D9D9D9");borders.append(item)
        props.append(borders)
        for p in cell.paragraphs:
            p.paragraph_format.space_before=Pt(7);p.paragraph_format.space_after=Pt(7)
            for run in p.runs:
                run.font.size=Pt(10)
                if index==0:run.bold=True;run.font.color.rgb=RGBColor(255,255,255)
doc.add_heading("Review the result",level=1)
doc.add_paragraph("Check the live controls in the Browser tab, inspect source edits in Changes and open each saved artifact. A completed worker turn remains a review candidate until the result has been checked.")
footer=section.footer.paragraphs[0];footer.text="MEMCODE   /   LOCAL BROWSER LAB";footer.runs[0].font.size=Pt(8)
output.parent.mkdir(parents=True,exist_ok=True);doc.save(output)
print(str(output))
