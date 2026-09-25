"""Extract only anonymized score fields from the official admission-list PDF."""
import json
import re
import sys
from pathlib import Path
from pypdf import PdfReader

source = Path(sys.argv[1])
target = Path(sys.argv[2])
pattern = re.compile(r'^(\d+)\s+\d{15}\s+\S+\s+812\s+计算机科学与技术学院\s+(\d{6})\s+\S+\s+\d{2}\s+.+?\s+(非全日制|全日制)\s+(\d{3})\s+([\d.]+)\s+([\d.]+)\s+拟录取\s*(.*)$')
records = []
reader = PdfReader(source)
for page_no, page in enumerate(reader.pages, 1):
    text = page.extract_text()
    for line in text.splitlines():
        if '812 计算机科学与技术学院' not in line:
            continue
        match = pattern.fullmatch(line.strip())
        if not match:
            raise ValueError(f'Unrecognized college score row on page {page_no}')
        row, code, mode, initial, retest, composite, note = match.groups()
        records.append(dict(sourceRow=int(row), sourcePage=page_no, program=code, mode=mode,
                            initial=int(initial), retest=float(retest), composite=float(composite),
                            plan=note.strip() or '普通计划'))
assert len(records) == 82, f'Expected 82 college rows, got {len(records)}'
assert [r['sourceRow'] for r in records] == list(range(1411, 1493))
payload = dict(year=2025, verifiedAt='2026-09-23',
               sourceUrl='https://gs.hainanu.edu.cn/__local/2/17/18/8FE16B5262A9AF88298B1D10A12_9D94D8C8_100F3E.pdf',
               sourceTitle='海南大学2025年硕士研究生拟录取名单（不含推免生）',
               scope='学院代码812；拟录取公示口径，不代表最终报到人数；未区分一志愿与调剂', records=records)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Extracted {len(records)} anonymized records')
