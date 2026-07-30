# Doctrine Follow-up App — Dovah Design System

## Purpose

This document defines the visual and UX design system for the Doctrine Follow-up app. It must be followed exactly. Do not improvise, do not add decorative elements, do not use generic SaaS styling. Every element must justify its existence.

The app is an internal operations tool for a mobile performance marketing professional. It manages bulk email follow-up scheduling for 200+ prospect batches. The user is not browsing. The user is executing.

---

## Core Tone

The interface must feel: strong, premium, calm under pressure, performance-oriented, slightly intimidating in a good way, highly intentional.

It must NOT feel: noisy, cute, overly friendly, bloated, playful, generic SaaS.

Simple formula: **clarity + control + sharp hierarchy + restrained power + performance-first UX**

---

## Color System

Use CSS variables everywhere. No hardcoded hex values in components.

```css
:root {
  /* Foundations */
  --bg-primary: #0a0b0d;           /* Main background — near black */
  --bg-secondary: #111318;          /* Cards, panels */
  --bg-tertiary: #181a20;           /* Hover states, nested surfaces */
  --bg-elevated: #1e2028;           /* Modals, dropdowns, popovers */

  /* Borders */
  --border-default: #1f2129;        /* Subtle structural borders */
  --border-hover: #2a2d38;          /* Hover emphasis */
  --border-active: #3d4150;         /* Active/selected states */

  /* Text */
  --text-primary: #e8e9ed;          /* Main content text */
  --text-secondary: #8b8e9a;        /* Labels, descriptions, secondary info */
  --text-tertiary: #555867;         /* Placeholders, disabled, hints */
  --text-inverse: #0a0b0d;          /* Text on accent backgrounds */

  /* Accent — single strong accent, used sparingly */
  --accent: #3b82f6;                /* Primary action color — strong blue */
  --accent-hover: #2563eb;          /* Accent hover */
  --accent-muted: rgba(59,130,246,0.10); /* Accent backgrounds */
  --accent-border: rgba(59,130,246,0.25); /* Accent border tint */

  /* Semantic — only for data states, never for decoration */
  --success: #22c55e;
  --success-muted: rgba(34,197,94,0.10);
  --warning: #eab308;
  --warning-muted: rgba(234,179,8,0.10);
  --danger: #ef4444;
  --danger-muted: rgba(239,68,68,0.10);
  --info: #6366f1;
  --info-muted: rgba(99,102,241,0.10);
}
```

### Color rules

- The accent color is used ONLY for primary CTAs, selected states, and active indicators. Nowhere else.
- Semantic colors are used ONLY to represent data states (success, warning, error, info). Never for decoration.
- Backgrounds layer from darkest (bg-primary) to lightest (bg-elevated). Maximum 3 layers deep.
- Borders are barely visible. They structure, they don't decorate.
- No gradients. No glows. No shadows except a single subtle shadow on elevated elements: `0 4px 24px rgba(0,0,0,0.4)`.

---

## Typography

```css
:root {
  --font-display: 'Geist', -apple-system, sans-serif;    /* Headings, stats */
  --font-body: 'Geist', -apple-system, sans-serif;       /* Body text */
  --font-mono: 'Geist Mono', 'JetBrains Mono', monospace; /* Data, numbers, code */
}
```

Load Geist from: `https://cdn.jsdelivr.net/npm/geist@1.0.0/dist/fonts/geist-sans/`
Load Geist Mono from: `https://cdn.jsdelivr.net/npm/geist@1.0.0/dist/fonts/geist-mono/`

If Geist is unavailable, fall back to `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. Do NOT use Inter, Roboto, Arial, or any generic web font.

### Type scale

| Element | Size | Weight | Font | Letter spacing |
|---------|------|--------|------|---------------|
| Page title | 20px | 600 | display | -0.02em |
| Section header | 14px | 600 | display | -0.01em |
| Card title | 13px | 600 | display | 0 |
| Body text | 13px | 400 | body | 0 |
| Label / caption | 11px | 500 | body | 0.04em, uppercase |
| Data / number | 24px | 600 | mono | -0.02em |
| Small data | 13px | 500 | mono | 0 |
| Table cell | 13px | 400 | body | 0 |

### Typography rules

- Headings are bold and confident. Body text is clean and readable.
- All stat numbers use the monospace font. Numbers are proof, not decoration.
- Labels and captions are uppercase, small, tracked out. They whisper structure.
- Never use font sizes below 11px.
- Never use more than 3 font weights on a single screen (400, 500, 600).

---

## Spacing System

Use a 4px base grid. All spacing should be multiples of 4.

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
}
```

### Spacing rules

- Generous spacing creates authority. Crowded layouts feel weak.
- Card padding: 16px minimum, 20px preferred.
- Section gaps: 24px between cards, 32px between sections.
- Table row height: 44px minimum for comfortable interaction.
- Never let content touch container edges. Minimum 12px internal padding on all containers.

---

## Components

### Cards

```css
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 20px;
}

.card:hover {
  border-color: var(--border-hover);
}
```

- No shadows on cards by default. Shadow only on elevated/floating elements.
- Border radius: 8px for cards, 6px for buttons/inputs, 4px for badges/pills.
- One card = one purpose. Do not overload cards with unrelated content.

### Stat cards

```css
.stat-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 16px 20px;
}

.stat-label {
  font: 500 11px/1 var(--font-body);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}

.stat-value {
  font: 600 24px/1 var(--font-mono);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}
```

- Stat values are the dominant element. Labels whisper, values shout.
- Use semantic colors on stat values only when they represent a status: green for positive metrics, amber for attention, red for problems.

### Buttons

```css
/* Primary — accent colored, used for THE main action on screen */
.btn-primary {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font: 500 13px/1 var(--font-body);
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}

.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:active { transform: scale(0.98); }
.btn-primary:disabled { opacity: 0.3; cursor: default; transform: none; }

/* Secondary — for non-primary actions */
.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 8px 16px;
  font: 500 13px/1 var(--font-body);
  cursor: pointer;
  transition: all 0.15s;
}

.btn-secondary:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
  background: var(--bg-tertiary);
}

/* Ghost — for tertiary actions (cancel, close, dismiss) */
.btn-ghost {
  background: transparent;
  color: var(--text-tertiary);
  border: none;
  padding: 8px 12px;
  font: 500 13px/1 var(--font-body);
  cursor: pointer;
}

.btn-ghost:hover { color: var(--text-secondary); }

/* Danger — destructive actions only */
.btn-danger {
  background: transparent;
  color: var(--danger);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: 6px;
  padding: 8px 16px;
  font: 500 13px/1 var(--font-body);
}
```

- Maximum ONE primary button per screen section. If everything is primary, nothing is.
- Button text should be action verbs: "Queue follow-ups", "Sync now", "Cancel". Not "Submit" or "OK".
- No icons in buttons unless the icon adds comprehension the text cannot.

### Tables

```css
.table-header {
  display: grid;
  padding: 0 16px;
  height: 36px;
  align-items: center;
  font: 500 11px/1 var(--font-body);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-default);
}

.table-row {
  display: grid;
  padding: 0 16px;
  min-height: 44px;
  align-items: center;
  font: 400 13px/1.4 var(--font-body);
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
  transition: background 0.1s;
}

.table-row:hover { background: var(--bg-tertiary); }
.table-row.disabled { opacity: 0.3; }
```

- Tables are for data, not layout. Every column must have a purpose.
- Column headers are uppercase labels in --text-tertiary. They guide, they don't compete.
- Row hover is subtle. Background shift only, no border changes or color highlights.
- Checkboxes in tables use `accent-color: var(--accent)`.

### Pills / filters

```css
.pill {
  font: 500 12px/1 var(--font-body);
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.pill:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.pill.active {
  background: var(--accent-muted);
  border-color: var(--accent-border);
  color: var(--accent);
}
```

### Status badges

```css
.badge {
  font: 500 11px/1 var(--font-mono);
  padding: 3px 8px;
  border-radius: 4px;
  display: inline-block;
}

.badge-queued { background: var(--accent-muted); color: var(--accent); }
.badge-sent { background: var(--success-muted); color: var(--success); }
.badge-failed { background: var(--danger-muted); color: var(--danger); }
.badge-cancelled { background: var(--bg-tertiary); color: var(--text-tertiary); }
.badge-unreplied { background: var(--warning-muted); color: var(--warning); }
.badge-replied { background: var(--success-muted); color: var(--success); }
```

### Inputs

```css
input, select {
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 8px 12px;
  font: 400 13px/1 var(--font-body);
  color: var(--text-primary);
  transition: border-color 0.15s;
}

input:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-muted);
}

input::placeholder { color: var(--text-tertiary); }
```

---

## Layout

### Sidebar navigation

```css
.sidebar {
  width: 220px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-default);
  padding: 20px 0;
  height: 100vh;
  position: fixed;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  font: 500 13px/1 var(--font-body);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.1s;
}

.nav-item:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.nav-item.active {
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border-right: 2px solid var(--accent);
}
```

### Main content

```css
.main {
  margin-left: 220px;
  padding: 32px;
  max-width: 1100px;
}
```

### Page structure

Each page follows this hierarchy:
1. Page title (20px, 600 weight) — one line, no subtitle
2. Stats row (if applicable) — max 5 stat cards in a grid
3. Toolbar — filters, bulk actions, one primary CTA
4. Content — table, cards, or list
5. Sticky action bar (if batch operations are available)

---

## Motion

```css
/* Default transition for all interactive elements */
transition: all 0.15s ease;

/* Button press feedback */
.btn:active { transform: scale(0.98); }

/* Page load — stagger card appearance */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.card { animation: fadeUp 0.3s ease both; }
.card:nth-child(2) { animation-delay: 0.05s; }
.card:nth-child(3) { animation-delay: 0.1s; }
```

### Motion rules

- All transitions are 0.15s. Nothing slower than 0.3s.
- No bouncing, no elastic easing, no spring physics.
- Motion confirms action. It does not entertain.
- Loading states use a simple spinner or skeleton, never a progress bar with percentage.
- Toast notifications slide in from bottom-right, auto-dismiss after 3s.

---

## Toast notifications

```css
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 12px 20px;
  font: 400 13px/1.4 var(--font-body);
  color: var(--text-primary);
  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  transform: translateY(0);
  opacity: 1;
  transition: all 0.3s ease;
  z-index: 1000;
}
```

---

## Icons

Use Lucide icons (lucide.dev) at 16px size, 1.5px stroke weight. Icons are --text-secondary by default, --text-primary on hover.

Icons support comprehension, they do not become decoration. If removing an icon does not reduce understanding, remove it.

---

## UX Principles (Dovah-specific)

### One screen, one priority
- Dashboard: priority is batch overview and queue action
- Prospects: priority is selection and queueing
- Follow-ups: priority is status monitoring
- Settings: priority is Gmail connection

### Conversion paths must feel inevitable
- The "Queue follow-ups" button should always be visible when prospects are selected
- Selection count updates in real-time in the sticky action bar
- After queueing, show confirmation with scheduled date range — no ambiguity

### Friction must exist only where it protects value
- No confirmation modal for queueing (low-risk, reversible via cancel)
- Confirmation required for: disconnecting Gmail, cancelling all follow-ups in a batch
- API key entry on first visit is acceptable friction — it protects access

### Data must look authoritative
- All numbers use monospace font
- Stats update on every page load, not just on manual refresh
- Reply detection results show in real-time after sync
- Scheduled dates show in the user's local timezone

### Feedback for every action
- Sync: toast with "Synced X emails, Y new replies detected"
- Queue: toast with "Queued X follow-ups (Mar 26 – Apr 2)"
- Cancel: toast with "Cancelled X follow-ups"
- Error: toast with red left border and error message

---

## Anti-patterns (DO NOT)

- Do not use rounded corners larger than 8px
- Do not use colored backgrounds on page-level containers
- Do not use box shadows on cards (only on floating/elevated elements)
- Do not use gradient backgrounds
- Do not use emoji anywhere in the UI
- Do not use placeholder illustrations or decorative SVGs
- Do not use loading bars with percentages
- Do not use modal dialogs for simple confirmations (use inline)
- Do not use more than one accent color
- Do not center-align body text
- Do not use light theme
- Do not use Inter, Roboto, Arial, or Open Sans
- Do not add tooltips unless the element is genuinely ambiguous
- Do not use "Welcome back" or greeting messages
- Do not add onboarding tours or walkthrough overlays
