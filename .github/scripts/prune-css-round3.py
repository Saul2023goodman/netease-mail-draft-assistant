from pathlib import Path
import re

path = Path('app.css')
css = path.read_text(encoding='utf-8')

tokens = [
    'nmda-nav-count',
    'nmda-bulk-editor',
    'nmda-batch-filter-bar',
    'nmda-search-help',
    'nmda-bulk-disable',
]

for token in tokens:
    count = css.count(token)
    if count == 0:
        raise SystemExit(f'expected legacy CSS token missing before cleanup: {token}')
    print(f'before {token}: {count}')

# Remove standalone dead rules. [^{}]* intentionally spans declaration newlines but
# never crosses into another CSS block.
standalone_patterns = [
    r'(?m)^[ \t]*\.nmda-nav-count(?:\[hidden\])?[ \t]*\{[^{}]*\}[ \t]*\n?',
    r'(?m)^[ \t]*\.nmda-bulk-editor[ \t]*\{[^{}]*\}[ \t]*\n?',
    r'(?m)^[ \t]*\.nmda-batch-filter-bar[ \t]*\{[^{}]*\}[ \t]*\n?',
    r'(?m)^[ \t]*\.nmda-search-help[ \t]*\{[^{}]*\}[ \t]*\n?',
    r'(?m)^[ \t]*#nmda-bulk-disable\[hidden\][ \t]*\{[^{}]*\}[ \t]*\n?',
]
for pattern in standalone_patterns:
    css = re.sub(pattern, '', css)

# Historical one-line media wrappers containing only the dead bulk editor rule.
css = re.sub(
    r'(?m)^@media\s*\(max-width:(?:1100|980)px\)\s*\{\s*\.nmda-bulk-editor\s*\{[^{}]*\}\s*\}\s*\n?',
    '',
    css,
)

# Mixed responsive selector lists: preserve the still-live selectors.
css = css.replace(
    '.nmda-filter-bar, .nmda-bulk-editor, .nmda-contact-toolbar',
    '.nmda-filter-bar, .nmda-contact-toolbar',
)
css = css.replace(
    '.nmda-filter-bar, .nmda-bulk-editor, .nmda-contact-toolbar-unified, .nmda-run-controls-simple',
    '.nmda-filter-bar, .nmda-contact-toolbar-unified, .nmda-run-controls-simple',
)

# Final legacy hide patch becomes unnecessary once the underlying dead rules are gone.
css = re.sub(
    r'(?m)^/\* Hide legacy UI concepts that are now folded into the actual task flow\. \*/\n'
    r'\.nmda-nav-count,\.nmda-bulk-editor,\.nmda-batch-filter-bar,\.nmda-search-help\s*\{[^{}]*\}\s*\n?',
    '',
    css,
)

for token in tokens:
    if token in css:
        raise SystemExit(f'legacy CSS token remains after cleanup: {token}')

if css == path.read_text(encoding='utf-8'):
    raise SystemExit('cleanup produced no diff')

path.write_text(css, encoding='utf-8')
print('round 3 CSS cleanup passed')
