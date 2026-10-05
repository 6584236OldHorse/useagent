# DOCX plain-source line break regression

## Live reproduction

1. Open the QA-only delivered `qa-opencode.txt` artifact in the workspace editor.
2. Its source contains two lines: `OPEN_CODE_QA` and `Copper Δ Finch`.
3. Export the Document workpiece to DOCX.
4. Open/render the downloaded DOCX. Before the fix, both lines appear on one line.

The artifact editor itself saved revision 1, survived browser reload/reopen, and saved the restored original content at revision 2. The defect is in DOCX generation, not save durability: the original OOXML emitted a literal newline inside `w:t`, which Word-compatible rendering treats as whitespace.

## Smallest fix

Use the installed DOCX library's native text-run break option, and normalize CRLF/lone CR before separating paragraphs. The rich document/HTML export path is untouched. No new parser, dependency or configuration is added.

The regression checks actual exported OOXML for two paragraphs separated by a blank source line, one native line break within the first paragraph, and normalized carriage returns. It failed before the change and passes afterward.

## Evidence

- `before.png`: actual production DOCX rendered with bundled LibreOffice; the two source lines collapse onto one line.
- `after.png`: the same exact two-line source exported using the patched package and rendered with the same tool; both lines and the Delta glyph are preserved.
- All 23 artifact-format tests pass, including existing rich-document formatting coverage. Pinned TypeScript 5.9.3 full-root check passes. Independent code review is APPROVE and architecture is CLEAR; a scoped cleanup pass made no further changes. Post-pass tests/typecheck remain green. Full repository CI remains required.
- Package lint has no configured script. An explicit Biome scan reports seven existing source errors and six warnings, identical to the byte-verified unchanged baseline; the test scan exits zero with existing warnings. None comes from the two changed source lines or the new regression. Unrelated lint debt was not modified.

The source and before/after artifacts are synthetic QA data. Existing user files and the original downloaded artifact were not modified. This local after-render is not a claim that the patch has been deployed.
