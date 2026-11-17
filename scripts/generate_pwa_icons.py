#!/usr/bin/env python3
"""Build standard PWA PNG/ICO files from approved DEMETRA brand vector assets."""
from pathlib import Path
from io import BytesIO
from PIL import Image
import cairosvg

ROOT=Path(__file__).resolve().parents[1]
ICONS=ROOT / 'assets' / 'icons'
SIZE_NAMES={
  32:'favicon-32.png',48:'icon-48.png',72:'icon-72.png',
  96:'icon-96.png',128:'icon-128.png',144:'icon-144.png',
  152:'icon-152.png',180:'apple-touch-icon.png',192:'icon-192.png',
  256:'icon-256.png',384:'icon-384.png',512:'icon-512.png'
}
def render(source, size):
    svg=source.read_bytes()
    raster=cairosvg.svg2png(bytestring=svg,output_width=size*2,output_height=size*2)
    img=Image.open(BytesIO(raster)).convert('RGB')
    return img.resize((size,size),Image.Resampling.LANCZOS)
def save_png(source,size,path):
    render(source,size).save(ICONS / path,format='PNG',optimize=True)
def main():
    primary=ICONS/'icon.svg'
    maskable=ICONS/'icon-maskable.svg'
    assert primary.is_file() and maskable.is_file()
    for size,name in SIZE_NAMES.items():
        save_png(primary,size,name)
    save_png(maskable,512,'icon-maskable-512.png')
    render(primary,64).save(ICONS/'favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48),(64,64)])
    for size,name in SIZE_NAMES.items():
        with Image.open(ICONS/name) as image:
            assert image.size==(size,size) and image.mode=='RGB',name
    for fname in ('icon-maskable-512.png','favicon.ico'):
        assert (ICONS/fname).stat().st_size>100,fname
    print(f'Generated {len(SIZE_NAMES)+2} branded PWA icon assets')
if __name__=='__main__': main()
