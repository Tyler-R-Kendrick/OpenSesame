"""Verify native viewport embedding and lossless PNG-to-WebP decoded RGBA equality."""
from pathlib import Path
import hashlib
import json
import os
from PIL import Image

root = Path(os.environ.get('PWA_TAILSCALE_EVIDENCE_OUT', Path(__file__).parent))
layout = json.loads((root / 'composition-layout.json').read_text())
receipts = []
for sheet in layout:
    source = root / sheet['file']
    target = source.with_suffix('.webp')
    embedded = []
    with Image.open(source) as image:
        original = image.convert('RGBA')
        for viewport in sheet['images']:
            x, y = viewport['x'], viewport['y']
            width, height = viewport['width'], viewport['height']
            if any(int(n) != n for n in (x, y, width, height)):
                raise RuntimeError('A screenshot landed on a fractional pixel')
            with Image.open(root / viewport['source']) as raw:
                raw = raw.convert('RGBA')
                actual = original.crop((int(x), int(y), int(x+width), int(y+height)))
                if raw.size != actual.size or raw.tobytes() != actual.tobytes():
                    raise RuntimeError('Embedded viewport pixels changed')
                embedded.append({**viewport, 'decodedPixelEquality': True,
                    'decodedRgbaSha256': hashlib.sha256(raw.tobytes()).hexdigest(),
                    'sourcePngSha256': hashlib.sha256((root / viewport['source']).read_bytes()).hexdigest()})
        original.save(target, format='WEBP', lossless=True, method=6, exact=True)
    with Image.open(target) as image:
        decoded = image.convert('RGBA')
        if decoded.size != original.size or decoded.tobytes() != original.tobytes():
            raise RuntimeError('Decoded pixels changed during lossless compression')
    receipts.append({'source': source.name, 'target': target.name,
        'width': original.width, 'height': original.height,
        'sourceBytes': source.stat().st_size, 'targetBytes': target.stat().st_size,
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'targetSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'decodedRgbaSha256': hashlib.sha256(original.tobytes()).hexdigest(),
        'decodedPixelEquality': True, 'resized': False, 'cropped': False,
        'nativeViewportEmbeddings': embedded})
(root / 'lossless-gallery-receipt.json').write_text(json.dumps(receipts, indent=2) + '\n')
print(json.dumps(receipts, indent=2))
