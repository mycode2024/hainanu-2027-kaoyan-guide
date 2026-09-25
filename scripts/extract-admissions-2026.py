"""Extract anonymized scores for the December 2025 exam / 2026 intake."""
import json
import re
import sys
from pathlib import Path
import fitz

source, target = Path(sys.argv[1]), Path(sys.argv[2])
pattern = re.compile(r'^(\d+)\s+\S+\s+\d{15}\s+812\s+计算机科学与技术学院\s+(\d{6})\s+\S+\s+\d{2}\s+.+?\s+(非全日制|全日制)\s+(\d{3})\s+([\d.]+)\s+([\d.]+)\s+拟录取\s*(.*)$')
records = []
with fitz.open(source) as document:
    assert '2026年硕士研究生拟录取名单' in document[0].get_text().replace(' ', '')
    for page_no, page in enumerate(document, 1):
        for line in page.get_text(sort=True).splitlines():
            if '计算机科学与技术学院' not in line:
                continue
            match = pattern.fullmatch(line.strip())
            if not match:
                raise ValueError(f'Unrecognized college score row on page {page_no}')
            row, code, mode, initial, retest, composite, note = match.groups()
            records.append(dict(sourceRow=int(row), sourcePage=page_no, program=code, mode=mode,
                                initial=int(initial), retest=float(retest), composite=float(composite),
                                plan=note.strip() or '普通计划'))
assert len(records) == 94, f'Expected 94 college rows, got {len(records)}'
assert [r['sourceRow'] for r in records] == list(range(1458, 1552))
assert sorted(set(r['sourcePage'] for r in records)) == [53, 54, 55, 56]
payload = dict(year=2026, examYear=2025, verifiedAt='2026-09-23',
               sourceUrl='https://gs.hainanu.edu.cn/__local/0/6D/6F/CB936332381D12B6ACB9BBAB8EF_4E26C726_110B69.pdf',
               sourceTitle='海南大学2026年硕士研究生拟录取名单（不含推免生）',
               announcementUrl='https://gs.hainanu.edu.cn/info/1024/8562.htm',
               announcementDate='2026-04-27',
               rulesUrl='https://cs.hainanu.edu.cn/info/1086/11860.htm', rulesDate='2026-03-24',
               scope='2025年12月初试、2026年录取；学院代码812；拟录取公示口径，不代表最终报到人数；未区分一志愿与调剂', records=records)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Extracted {len(records)} anonymized records for intake 2026')
