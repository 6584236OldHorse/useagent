# PPTX import font-size regression

The live app clipped text in a generated 13.333 by 7.5 inch PPTX even though the downloaded original rendered with the full subtitle and all three card lines. The importer used its own export slide's 405-point height when converting every incoming font size, ignoring the imported slide's actual 540-point height.

A 20-point subtitle therefore became 53 reference pixels instead of 40 on the 1080-pixel canonical canvas. The fix uses actual slide height in the existing conversion. No text-fitting heuristic or layout rewrite is introduced.

The screenshot uses the same downloaded QA slide and production DeckSlideCanvas component before/after import. The old input clips text; the corrected input displays the complete subtitle and all three card lines.

![Same canvas with old and corrected import scale](comparison.png)

The original downloaded bytes remain unchanged. This validates this unit-conversion defect, not complete fidelity for unsupported PowerPoint features such as per-run fonts or native auto-fit.
