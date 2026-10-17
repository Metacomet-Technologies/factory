shadcn Table: semantic table parts with hairline rows. Used for LLM model performance at ≥640 px; below that the same data renders as Tile + KeyValue cards.

Source: `ui/table.tsx`; overrides `index.css:1282-1302, 1400-1403`.

**Consumer provides:** `Table.Header/Body/Footer/Row/Head/Cell/Caption`. Head 40 px, 8 px padding, 500; cell 8 px; rows `border`, hover `muted` 50%. In `.model-table`: 12 px, heads `muted-foreground` 550, 4 px block padding at ≥1280. The UPS battery trend uses a raw `<table class="ups-trend">` instead.
