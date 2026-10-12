"""Generate reproducible L1 study stimuli; requires Pillow and FFmpeg only at build time."""
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'media'
W, H, FPS, SECONDS = 480, 280, 30, 3
BASE, DOT = '#35204f', '#f9bd77'
LABELS = {'leaf': 'Лист', 'mitten': 'Варежка', 'mushroom': 'Гриб', 'umbrella': 'Зонтик',
          'pumpkin': 'Тыква', 'apple': 'Яблоко', 'fir': 'Ёлка', 'house': 'Дом',
          'fish': 'Рыба', 'butterfly': 'Бабочка', 'bell': 'Колокольчик', 'acorn': 'Жёлудь'}


def mask_for(shape):
    image = Image.new('L', (W * 2, H * 2))
    d = ImageDraw.Draw(image)
    def polygon(points): d.polygon([(x * 2, y * 2) for x, y in points], fill=255)
    def ellipse(box): d.ellipse(tuple(v * 2 for v in box), fill=255)
    def rect(box): d.rectangle(tuple(v * 2 for v in box), fill=255)
    if shape == 'leaf':
        polygon([(235,231),(240,190),(204,204),(207,177),(166,176),(183,153),(150,131),(184,125),(172,96),(208,113),(212,70),(232,91),(246,44),(259,91),(281,72),(282,114),(316,96),(305,129),(338,135),(310,155),(326,176),(284,178),(285,204),(252,191),(248,231)])
    elif shape == 'mitten':
        ellipse((210,48,292,132));rect((210,90,292,175));ellipse((205,124,292,208));rect((210,172,274,230));ellipse((173,124,218,164));polygon([(177,149),(211,186),(237,172),(206,132)])
    elif shape == 'mushroom':
        ellipse((150,53,331,201));rect((220,140,261,230));d.rectangle((280,286,680,410),fill=0);rect((220,140,261,230))
    elif shape == 'umbrella':
        ellipse((143,56,338,237));d.rectangle((0,286,W*2,H*2),fill=0);rect((236,134,244,213));d.arc((398,374,490,470),0,180,fill=255,width=16)
    elif shape == 'pumpkin':
        for box in [(154,96,252,224),(229,96,327,224),(187,82,292,234)]: ellipse(box)
        polygon([(235,100),(236,64),(261,54),(267,69),(251,79),(251,103)])
    elif shape == 'apple':
        ellipse((159,89,260,228));ellipse((221,89,322,228));polygon([(180,156),(305,156),(278,233),(240,223),(207,233)])
        polygon([(237,107),(239,62),(251,58),(249,107)]);ellipse((250,54,292,78))
    elif shape == 'fir':
        polygon([(242,40),(183,119),(207,119),(163,171),(194,171),(149,216),(334,216),(288,171),(318,171),(273,119),(299,119)]);rect((229,208,254,239))
    elif shape == 'house':
        polygon([(148,134),(239,52),(332,134),(313,151),(313,225),(166,225),(166,150)]);rect((282,63,303,111));d.rectangle((441,342,518,452),fill=0)
    elif shape == 'fish':
        ellipse((162,94,298,188));polygon([(290,139),(335,88),(335,194)]);polygon([(218,106),(236,65),(263,105)]);polygon([(214,175),(244,213),(266,176)])
    elif shape == 'butterfly':
        for box in [(151,59,241,164),(239,59,329,164),(168,142,242,224),(238,142,312,224)]: ellipse(box)
        ellipse((232,89,248,220));d.line([(480,195),(457,120)],fill=255,width=7);d.line([(480,195),(505,120)],fill=255,width=7)
    elif shape == 'bell':
        ellipse((225,48,255,78));ellipse((183,69,297,173));polygon([(184,121),(295,121),(302,184),(324,205),(156,205),(177,184)]);ellipse((222,198,258,232))
    elif shape == 'acorn':
        ellipse((185,88,297,216));polygon([(202,175),(280,175),(241,238)]);ellipse((174,65,309,139));rect((174,106,309,129));polygon([(237,77),(233,43),(249,41),(253,78)])
    elif shape == 'heart':
        ellipse((161,61,245,145));ellipse((235,61,319,145));polygon([(161,110),(319,110),(240,226)])
    else: raise ValueError(shape)
    return image.resize((W, H), Image.Resampling.LANCZOS)


def generate(shape, variant):
    seed = 81279 + variant * 7183
    randomizer = random.Random(seed)
    texture = Image.new('RGB', (W * 2, H * 2), BASE)
    d = ImageDraw.Draw(texture)
    for _ in range(2350):
        x, y = randomizer.random() * W, randomizer.random() * H
        for dx in [-W, 0, W]:
            for dy in [-H, 0, H]:
                xx, yy = (x + dx) * 2, (y + dy) * 2
                d.ellipse((xx-2.5, yy-2.5, xx+2.5, yy+2.5), fill=DOT)
    texture = texture.resize((W,H),Image.Resampling.LANCZOS)
    mask = mask_for(shape)
    identifier = hashlib.sha256(f'l1-survey-v1:{shape}:{seed}'.encode()).hexdigest()[:24]
    dest = OUT / f'{identifier}.mp4'
    if not dest.exists():
        command = ['ffmpeg','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}','-framerate',str(FPS),'-i','pipe:0','-frames:v',str(FPS*SECONDS),'-an','-c:v','libx264','-threads','2','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart','-y',str(dest)]
        proc = subprocess.Popen(command,stdin=subprocess.PIPE)
        for frame in range(FPS*SECONDS):
            time = frame/FPS
            background = ImageChops.offset(texture,round(-11*time),round(1.5*time))
            foreground = ImageChops.offset(texture,round(17*time),round(1.5*time))
            proc.stdin.write(Image.composite(foreground,background,mask).tobytes())
        proc.stdin.close()
        if proc.wait()!=0:
            dest.unlink(missing_ok=True)
            raise RuntimeError('FFmpeg failed')
    return {'id':identifier,'file':dest.name,'shape':shape,'variant':variant,'seed':seed,'duration':SECONDS,'fps':FPS,'width':W,'height':H,'bytes':dest.stat().st_size}


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    videos=[]
    for shape in LABELS:
        for variant in range(2):
            videos.append(generate(shape,variant))
            print(f'{shape} {variant+1}/2',flush=True)
    training=generate('heart',2)
    mask=mask_for('heart');image=Image.new('RGB',(W,H),BASE);image.paste(DOT,mask=mask);image.save(OUT/'training-reveal.png')
    (ROOT/'catalog.json').write_text(json.dumps({'version':'l1-v1','labels':LABELS,'training':training,'videos':videos},ensure_ascii=False,indent=2)+'\n')
    sheet=Image.new('RGB',(W*4,H*3),'#35204f')
    for i,shape in enumerate(LABELS):
        tile=Image.new('RGB',(W,H),BASE);tile.paste(DOT,mask=mask_for(shape));sheet.paste(tile,((i%4)*W,(i//4)*H))
    sheet.save(ROOT/'tools'/'shape-contact-sheet.png')
    print(f'Prepared {len(videos)+1} videos, {sum(v["bytes"] for v in videos)/1024/1024:.1f} MiB',flush=True)
