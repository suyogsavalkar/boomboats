#!/usr/bin/env python3
"""Cut the Boomboats trailer: graded segments on the music's bar grid, titles, music + stingers."""
import os, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CLIPS = os.path.join(ROOT, '..', 'rec', 'clips')
CARDS = os.path.join(ROOT, 'cards')
AUD = os.path.join(ROOT, '..', 'game', 'public', 'audio')
SEG = os.path.join(ROOT, 'seg')
os.makedirs(SEG, exist_ok=True)
FPS = 60
BPM = 178.63
BAR = 4 * 60 / BPM
HIT = 3.0                       # the logo slam lands on a music beat here
MUSIC_START = HIT - 0.325       # first beat in the music file is at 0.325 s

GRADE = "eq=contrast=1.06:saturation=1.3:gamma=0.98"
SKY = os.path.join(ROOT, 'skygrad.png')

# (clip, start, bars-or-seconds, options)
B = lambda n: n * BAR
TIMELINE = [
    ('aerial', 0.0, 3.0, dict(fadein=1.0, sky=0.6, gain=0.25)),
    ('aerial', 3.0, B(2), dict(card='logo', mode='slam', flash=True, sky=0.6, gain=0.4)),
    ('hero', 0.2, B(1.5), dict(card='c_throttle', mode='pop', cs=0.15)),
    ('side', 0.0, B(1), {}),
    ('ramp', 0.55, B(1.5), dict(speed=0.5, skyfile='skygrad_tall.png')),
    ('pickup2', 0.2, B(1), dict(speed=0.75, zoom=1.3, card='c_loot', mode='pop', cs=0.0)),
    ('rockets', 0.6, B(1.5), dict(card='w_rockets', mode='slide')),
    ('gun', 3.3, B(1.5), dict(card='w_gun', mode='slide')),
    ('mines', 0.3, B(1.5), dict(card='w_mines', mode='slide')),
    ('torpedo', 4.2, B(1.5), dict(card='w_torpedo', mode='slide')),
    ('nitro', 0.0, B(1.5), dict(card='w_nitro', mode='slide')),
    ('shield', 0.3, B(1.5), dict(card='w_shield', mode='slide')),
    ('wave', 0.6, B(2), dict(card='w_wave', mode='slide', sky=0.5)),
    ('sink', 0.45, B(1.5), dict(speed=0.6, card='c_smash', mode='pop', cs=0.25)),
    ('hero', 3.0, B(1), {}),
    ('battle', 1.4, B(2), dict(card='c_players', mode='pop', cs=0.1)),
    ('showcase', 0.5, B(2.5), dict(card='c_boats', mode='pop', cs=0.1)),
    ('ramp2', 0.5, B(1.5), dict(speed=0.6)),
    ('orbit', 0.5, B(4), dict(sky=0.5, card='end', mode='end', darken=True, fadeout=0.6)),
]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(' '.join(cmd)); print(r.stderr[-3000:]); sys.exit(1)


def segment(i, clip, start, dur, o, nframes):
    out = os.path.join(SEG, f'{i:02d}_{clip}.mp4')
    dur = nframes / FPS
    sp = o.get('speed', 1.0)
    src_dur = dur * sp
    inputs = ['-ss', f'{max(0, start - 1):.3f}', '-i', os.path.join(CLIPS, clip + '.mp4'),
              '-loop', '1', '-framerate', '60', '-t', f'{dur + 0.2:.3f}', '-i', os.path.join(ROOT, o['skyfile']) if o.get('skyfile') else SKY]
    pre = start - max(0, start - 1)
    v = (f"[0:v]trim=start={pre:.4f}:duration={src_dur + 0.05:.4f},setpts=(PTS-STARTPTS)/{sp},")
    v += "fps=60,"
    z = o.get('zoom')
    if z:
        v += f"crop=iw/{z}:ih/{z},"
    v += f"scale=1920:1080:flags=lanczos,format=gbrp[raw];[sky]format=gbrp[skyg];[raw][skyg]blend=all_mode=multiply:all_opacity={o.get('sky', 0.85)},{GRADE},format=yuv420p,trim=end_frame={nframes}"
    if o.get('darken'):
        v += ",eq=brightness=-0.06:saturation=1.1,gblur=sigma=1.5"
    if o.get('fadein'):
        v += f",fade=in:st=0:d={o['fadein']}"
    if o.get('fadeout'):
        pass  # the final fade happens after the end card overlay
    v += "[v0]"
    graph = ["[1:v]setpts=PTS-STARTPTS[sky]", v]
    last = 'v0'
    n_in = 2
    if o.get('flash'):
        graph.append(f"color=white:s=1920x1080:r=60:d={dur:.3f},format=rgba,fade=out:st=0:d=0.35:alpha=1[fl]")
        graph.append(f"[{last}][fl]overlay=format=auto[vf]"); last = 'vf'
    card = o.get('card')
    if card:
        inputs += ['-loop', '1', '-framerate', '60', '-t', f'{dur:.3f}', '-i', os.path.join(CARDS, card + '.png')]
        cs = o.get('cs', 0.0)
        mode = o.get('mode')
        c = f"[{n_in}:v]format=rgba,setpts=PTS-STARTPTS+{cs}/TB"
        fo = max(cs + 0.3, dur - 0.22)
        if mode == 'slam':
            c += (f",scale=w='1920*(1+1.6*exp(-14*max(t-{cs},0)))':h=-1:eval=frame,"
                  f"fade=in:st={cs}:d=0.06:alpha=1,fade=out:st={dur - 0.3:.3f}:d=0.3:alpha=1[c]")
            graph.append(c); graph.append(f"[{last}][c]overlay=x=(W-w)/2:y=(H-h)/2:eval=frame:format=auto[vc]")
        elif mode == 'pop':
            c += (f",scale=w='1920*(1+0.35*exp(-16*max(t-{cs},0)))':h=-1:eval=frame,"
                  f"fade=in:st={cs}:d=0.08:alpha=1,fade=out:st={fo:.3f}:d=0.2:alpha=1[c]")
            graph.append(c); graph.append(f"[{last}][c]overlay=x=(W-w)/2:y=(H-h)/2-290:eval=frame:format=auto[vc]")
        elif mode == 'slide':
            c += f",fade=in:st={cs + 0.05}:d=0.12:alpha=1,fade=out:st={fo:.3f}:d=0.2:alpha=1[c]"
            graph.append(c); graph.append(f"[{last}][c]overlay=x='min(0,-900+max(t-{cs},0)*6000)':y=0:eval=frame:format=auto[vc]")
        elif mode == 'end':
            c += f",fade=in:st=0.15:d=0.5:alpha=1[c]"
            graph.append(c); graph.append(f"[{last}][c]overlay=0:0:format=auto[vc]")
        last = 'vc'; n_in += 1
    if o.get('fadeout'):
        graph.append(f"[{last}]fade=out:st={dur - o['fadeout']:.3f}:d={o['fadeout']}[vo]"); last = 'vo'
    # audio: the take's own game sound; slow motion drops the pitch for weight
    a = f"[0:a]atrim=start={pre:.4f}:duration={src_dur + 0.05:.4f},asetpts=PTS-STARTPTS,aresample=44100"
    if sp < 1:
        a += f",asetrate={int(44100 * sp)},aresample=44100"
    a += f",apad,atrim=end={dur:.4f},afade=in:d=0.02,afade=out:st={max(0, dur - 0.03):.4f}:d=0.03"
    if o.get('fadein'):
        a += f",afade=in:d={o['fadein']}"
    a += f",volume={o.get('gain', 1.0)}"
    a += "[a]"
    graph.append(a)
    cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(graph),
           '-map', f'[{last}]', '-map', '[a]', '-frames:v', str(nframes), '-r', '60',
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p',
           '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', out.replace('.mp4', '.mov')]
    run(cmd)
    return out.replace('.mp4', '.mov')


def main():
    only = set(sys.argv[1:])
    t = 0.0
    segs, starts = [], []
    frame = 0
    for i, (clip, start, dur, o) in enumerate(TIMELINE):
        end_frame = round((t + dur) * FPS)
        n = end_frame - frame
        starts.append(frame / FPS)
        path = os.path.join(SEG, f'{i:02d}_{clip}.mov')
        if not only or str(i) in only or not os.path.exists(path):
            segment(i, clip, start, dur, o, n)
            print(f'seg {i:02d} {clip:9s} at {frame / FPS:6.2f}s  {n} frames')
        segs.append(path)
        frame = end_frame
        t += dur
    total = frame / FPS
    with open(os.path.join(SEG, 'list.txt'), 'w') as f:
        for s in segs:
            f.write(f"file '{s}'\n")
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', os.path.join(SEG, 'list.txt'),
         '-c', 'copy', os.path.join(ROOT, 'joined.mov')])

    # music + stingers
    end_card = starts[-1]
    mus_len = total - MUSIC_START
    stingers = [  # (file, time, gain, rate)
        ('horn.mp3', 0.7, 0.55, 1.0),
        ('explosion_2.mp3', HIT - 0.02, 1.0, 0.8),
        ('water_explosion.mp3', HIT - 0.02, 0.8, 1.0),
        ('explosion_1.mp3', end_card - 0.02, 1.0, 0.75),
        ('water_explosion.mp3', end_card - 0.02, 0.7, 0.85),
    ]
    inputs = ['-i', os.path.join(ROOT, 'joined.mov'),
              '-i', os.path.join(AUD, 'music_loop.mp3'),
              '-stream_loop', '-1', '-i', os.path.join(AUD, 'waves_loop.mp3')]
    graph = [
        f"[1:a]aresample=44100,atrim=duration={mus_len:.3f},afade=in:d=0.25,afade=out:st={mus_len - 2.6:.3f}:d=2.6,"
        f"volume=0.9,adelay={int(MUSIC_START * 1000)}|{int(MUSIC_START * 1000)}[mus]",
        f"[2:a]aresample=44100,atrim=duration=6,afade=in:d=0.8,afade=out:st=3.6:d=2.2,volume=0.55[wav]",
        f"[0:a]volume=0.85[sfx]",
    ]
    mix = ['[mus]', '[wav]', '[sfx]']
    for k, (fname, at, g, rate) in enumerate(stingers):
        inputs += ['-i', os.path.join(AUD, fname)]
        idx = 3 + k
        r = f"asetrate={int(44100 * rate)},aresample=44100," if rate != 1 else ""
        graph.append(f"[{idx}:a]aresample=44100,{r}volume={g},adelay={int(at * 1000)}|{int(at * 1000)}[s{k}]")
        mix.append(f'[s{k}]')
    graph.append(f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:duration=longest,atrim=duration={total:.3f},"
                 f"afade=out:st={total - 0.4:.3f}:d=0.4,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.0:LRA=11,aresample=48000[aout]")
    out = os.path.join(ROOT, 'Boomboats_Trailer.mp4')
    run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(graph),
         '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '256k', '-t', f'{total:.3f}', out])
    print(f'done: {out}  {total:.2f}s')


if __name__ == '__main__':
    main()
