"""Compress full PNG comparison sheets losslessly; verify every decoded RGBA byte."""
from pathlib import Path
import hashlib
import json
import os
from PIL import Image

root = Path(os.environ.get('PWA_AI_EVIDENCE_OUT', Path(__file__).parent))
receipts = []
for width in (1280, 390):
    source = root / f'{width}-ai-projection.png'
    target = source.with_suffix('.webp')
    with Image.open(source) as image:
        original = image.convert('RGBA')
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
        'decodedPixelEquality': True, 'resized': False, 'cropped': False})
(root / 'lossless-gallery-receipt.json').write_text(json.dumps(receipts, indent=2) + '\n')
print(json.dumps(receipts, indent=2))
