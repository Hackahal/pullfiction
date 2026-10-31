#!/usr/bin/env python3
"""Extract local GPU evidence and contact sheets; never infer visual approval."""
import argparse, base64, collections, hashlib, html, json, math, re, struct
from pathlib import Path

def camera_agreement(native):
    cameras=[native.get('configuredCamera'),native.get('camera'),native.get('pvs',{}).get('camera')]
    if any(not c for c in cameras):return None
    def direction(c):
        d=[b-a for a,b in zip(c['eye'],c['target'])];length=math.sqrt(sum(v*v for v in d))
        if not length:return None
        return [v/length for v in d]
    directions=[direction(c) for c in cameras]
    if any(d is None for d in directions):return False
    return all(math.dist(cameras[0]['eye'],c['eye'])<=.002 and sum(a*b for a,b in zip(directions[0],d))>=.9999 for c,d in zip(cameras[1:],directions[1:]))


def extract(report, output):
    if report.get('schema') != 1 or not isinstance(report.get('results'), list):
        raise ValueError('Expected renderer workbench report schema1')
    output.mkdir(parents=True, exist_ok=False)
    summary = {'schema': 1, 'client': report.get('client', report.get('build')),
               'renderer': report.get('renderer'), 'frames': [], 'counts': {},
               'visualApproval': 'unverified',
               'proof': 'GPU capture and frozen-repeat evidence only; no official fidelity or automatic visual approval.'}
    counts = collections.Counter()
    cards = []
    for index, row in enumerate(report['results']):
        state = row['status']; counts[state] += 1
        entry = {k: row.get(k) for k in ('caseId', 'label', 'category', 'timeMs', 'status', 'error', 'identical')}
        if state == 'captured':
            native = row.get('native', {})
            if native.get('captureSource') != 'bevy-gpu-readback':
                raise ValueError(f'{index}: not production GPU readback')
            prefix = 'data:image/png;base64,'
            if not row.get('image', '').startswith(prefix):
                raise ValueError(f'{index}: PNG missing')
            png = base64.b64decode(row['image'][len(prefix):], validate=True)
            if png[:8] != b'\x89PNG\r\n\x1a\n' or png[12:16] != b'IHDR':
                raise ValueError(f'{index}: invalid PNG header')
            digest = hashlib.sha256(png).hexdigest()
            if digest != row.get('hash'):
                raise ValueError(f'{index}: capture hash mismatch')
            if row.get('identical') is True and row.get('repeatHash') != digest:
                raise ValueError(f'{index}: frozen-repeat hash mismatch')
            width, height = struct.unpack('>II', png[16:24])
            name = f'{index:03d}-' + re.sub(r'[^a-zA-Z0-9_.-]+', '-', row['caseId']) + f'-{row["timeMs"]}.png'
            (output/name).write_bytes(png)
            entry.update(image=name, hash=digest, width=width, height=height,
                         cameraAgreement=camera_agreement(native),
                         nativeErrorCount=native.get('errorCount'), gpu=native.get('gpu'),
                         readiness=native.get('readiness'), resources=native.get('resources'))
            cards.append((name, row['label'], row['timeMs'], row.get('identical')))
        summary['frames'].append(entry)
    summary['counts'] = dict(counts)
    summary['renderedCases'] = len({r['caseId'] for r in report['results'] if r['status'] == 'captured'})
    summary['frozenRepeatsIdentical'] = sum(r.get('identical') is True for r in report['results'])
    summary['cameraDisagreements'] = sum(r.get('cameraAgreement') is False for r in summary['frames'])
    (output/'report.json').write_text(json.dumps(report)+'\n')
    (output/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    document = '<meta charset="utf-8"><title>Local renderer evidence</title><style>body{background:#121719;color:#ddd;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0}img{width:100%}figcaption{padding:8px}</style><h1>Local renderer evidence</h1><p>Visual approval remains a separate check. Client assets stay local.</p><main>'
    for name, label, time, same in cards:
        document += f'<figure><img src="{html.escape(name)}"><figcaption>{html.escape(label)} · {time}ms · frozen repeat {same}</figcaption></figure>'
    (output/'index.html').write_text(document+'</main>')
    return summary, cards


def contact_sheet(output, cards, stem='contact-sheet'):
    from PIL import Image, ImageDraw, ImageFont
    cell_w, cell_h, columns = 336, 246, 4
    sheet = Image.new('RGB', (cell_w*columns, cell_h*((len(cards)+columns-1)//columns)), '#121719')
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=12)
    for i, (name, label, time, same) in enumerate(cards):
        image = Image.open(output/name).convert('RGB');image.thumbnail((cell_w-8, 202))
        x, y = i%columns*cell_w, i//columns*cell_h
        sheet.paste(image, (x+4,y+4))
        draw.text((x+5,y+207),label[:45],font=font,fill='white')
        draw.text((x+5,y+225),f'{time}ms | frozen repeat {same}',font=font,fill='#b0b9bd')
    if cards: sheet.save(output/f'{stem}.png')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('report',type=Path);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--sheet',action='store_true',help='Requires Pillow; uses only actual captured pixels.')
    a=p.parse_args();report=json.loads(a.report.read_text())
    summary,cards=extract(report,a.output)
    if a.sheet:
        contact_sheet(a.output,cards)
        for start in range(0,len(cards),24):
            contact_sheet(a.output,cards[start:start+24],f'contact-sheet-{start//24+1:02d}')
    print(json.dumps({k:summary[k] for k in ('counts','renderedCases','frozenRepeatsIdentical','visualApproval')}))

if __name__=='__main__':main()
