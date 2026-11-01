# Design System

Ported from the POC (`app_mockup.html`, `pricing_poc.html`). All styles live in `src/app.css` as global CSS. Components are built as Svelte wrappers around these classes — no external CSS framework is used.

---

## CSS Custom Properties (tokens)

| Token           | Value       | Usage                         |
|-----------------|-------------|-------------------------------|
| `--navy`        | `#1B2B4B`   | Primary text, headings        |
| `--navy-dark`   | `#111D33`   | Sidebar background, gradient  |
| `--navy-soft`   | `#2A3F6F`   | Gradient end, dark accents    |
| `--orange`      | `#F5A100`   | Primary CTA, active states    |
| `--orange-dk`   | `#D98D00`   | Hover state for orange        |
| `--orange-lt`   | `#FFF4DC`   | Orange badge/card backgrounds |
| `--grey-bg`     | `#F6F8FB`   | Page background               |
| `--grey-line`   | `#E0E6EF`   | Borders, dividers             |
| `--grey-text`   | `#6B7A99`   | Secondary text, labels        |
| `--green`       | `#22C55E`   | Success / healthy             |
| `--red`         | `#EF4444`   | Errors / critical             |
| `--yellow`      | `#F59E0B`   | Warnings                      |
| `--blue`        | `#3B82F6`   | Info                          |
| `--radius`      | `12px`      | Standard card radius          |
| `--sidebar`     | `220px`     | Sidebar width                 |
| `--topbar-h`    | `58px`      | Topbar height                 |
| `--shadow`      | see file    | Card shadow                   |
| `--shadow-lg`   | see file    | Hover / modal shadow          |
| `--shadow-xl`   | see file    | Auth card shadow              |

---

## Reusable Components

### `Badge.svelte`
```svelte
<Badge variant="green">Active</Badge>
<Badge variant="red">Urgent</Badge>
<Badge variant="orange">In Review</Badge>
<Badge variant="blue">Info</Badge>
<Badge variant="grey">Inactive</Badge>
```
Variants: `green` `orange` `red` `blue` `grey` `navy` `yellow`

### `Button.svelte`
```svelte
<Button variant="primary" size="lg" full>Save</Button>
<Button variant="outline" size="sm">Cancel</Button>
<Button variant="danger">Delete</Button>
```
Props: `variant` (`primary|outline|ghost|danger`) · `size` (`sm|base|lg`) · `full` (boolean) · `disabled` · `type`

### `Card.svelte`
```svelte
<Card title="Recent Issues">
  <svelte:fragment slot="action">
    <a href="/issues">View all →</a>
  </svelte:fragment>
  <!-- content -->
</Card>
```

### `StatCard.svelte`
```svelte
<StatCard label="Open Issues" value="12" sub="3 require action" color="orange" />
```
Color options: `orange` `green` `red` `navy`

### `Toast.svelte`
```svelte
<script>
  import Toast from '$lib/components/ui/Toast.svelte';
  let toast: Toast;
</script>
<Toast bind:this={toast} />
<button on:click={() => toast.show('Saved!', '✓')}>Save</button>
```

---

## CSS Utility Classes

| Class              | Effect                                 |
|--------------------|----------------------------------------|
| `.card`            | White box with border + radius         |
| `.data-table`      | Styled table (th, td, hover rows)      |
| `.stat-card`       | KPI number card                        |
| `.badge`           | Pill label (combine with variant class)|
| `.btn`             | Base button (combine with variant)     |
| `.form-control`    | Styled input/select/textarea           |
| `.form-group`      | Label + input wrapper with spacing     |
| `.grid-2/3/4`      | CSS grid helpers                       |
| `.sub-tabs`        | Tab bar with orange active indicator   |
| `.alert-info/warn/success/error` | Status alert boxes       |
| `.modal-overlay`   | Fixed overlay for modals               |

---

## Adding new colours / tokens

Edit `src/app.css` in the `:root {}` block. All components reference CSS variables so the change propagates everywhere automatically.
