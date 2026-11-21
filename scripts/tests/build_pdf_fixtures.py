from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
p=Path("scripts/tests/fixtures");p.mkdir(parents=True,exist_ok=True)
c=canvas.Canvas(str(p/"pdf-text.pdf"),pagesize=(595,842))
c.setFont("Helvetica",14)
c.drawString(45,760,"Acer campestre 'Elsrijk'")
c.drawString(45,735,"Standard; visina 300-350 cm")
c.save()
im=Image.new("RGB",(1240,1754),"white")
d=ImageDraw.Draw(im)
font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",42)
d.text((100,140),"Acer campestre 'Elsrijk'",font=font,fill="black")
d.text((100,220),"Standard; visina 300-350 cm",font=font,fill="black")
im.save(p/"pdf-scan.pdf","PDF",resolution=150)
