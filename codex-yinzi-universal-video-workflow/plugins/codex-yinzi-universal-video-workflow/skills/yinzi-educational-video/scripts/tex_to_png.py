"""Render actual TeX. Input should be an agent-authored expression, not raw untrusted TeX."""
import argparse,tempfile
from pathlib import Path

def render(expression,output,width=1440,color='#152025',size=42):
    from manim import MathTex,Camera,tempconfig
    if width<100 or size<=0:raise ValueError('invalid render dimensions')
    output=output.resolve();output.parent.mkdir(parents=True,exist_ok=True)
    # Some Windows TeX installations fail with the legacy ~ short-name TEMP path.
    with tempfile.TemporaryDirectory(prefix='edu-tex-',dir=str(output.parent)) as temp:
        with tempconfig({'media_dir':temp}):
            formula=MathTex(expression,font_size=size,color=color)
            if formula.width>12:formula.scale_to_fit_width(12)
            frame_h=max(3.5,formula.height+.6);height=round(width*frame_h/14.222)
            camera=Camera(pixel_width=width,pixel_height=height,frame_width=14.222,frame_height=frame_h,background_opacity=0)
            camera.capture_mobjects([formula]);im=camera.get_image().convert('RGBA');box=im.getchannel('A').getbbox()
            if not box:raise RuntimeError('empty rendered formula')
            output.parent.mkdir(parents=True,exist_ok=True);im.crop(box).save(output)
    return output

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('expression');p.add_argument('--output',type=Path,required=True);p.add_argument('--width',type=int,default=1440);p.add_argument('--color',default='#152025');p.add_argument('--size',type=float,default=42);a=p.parse_args();print(render(a.expression,a.output,a.width,a.color,a.size))
