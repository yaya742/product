from PIL import Image, ImageDraw
from pathlib import Path
Path('build').mkdir(exist_ok=True)
scale = 4
im = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((64, 64, 960, 960), radius=212, fill='#25292a', outline='#42494a', width=3)
ink = '#d8e5dd'
d.arc((320, 225, 704, 609), 180, 360, fill=ink, width=18)
d.line((320, 417, 320, 766, 704, 766, 704, 417), fill=ink, width=18, joint='curve')
d.arc((440, 343, 588, 491), 180, 270, fill=ink, width=18)
d.line((440, 417, 440, 766), fill=ink, width=18)
d.line((514, 343, 696, 343), fill=ink, width=18)
d.ellipse((578, 550, 602, 574), fill=ink)
im.resize((512, 512), Image.Resampling.LANCZOS).save('build/icon.png')
im.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
