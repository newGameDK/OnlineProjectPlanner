# Suggested Improvements for OnlineProjectPlanner

The following 20 improvements would make the application significantly more useful
and polished, based on an analysis of the current workflow and user experience.

---

## 1. Drag-and-drop task reordering within the timeline

Allow users to reorder tasks vertically in the Gantt chart by dragging rows up or
down, not only via the task-list grip handle. Visual drop-zone indicators between
rows would make this intuitive.

## 2. Progress / completion percentage per task

Add a `progress` field (0–100 %) to each Gantt entry. Display a filled progress
bar inside the task bar and allow editing via the context menu or a quick-click on
the bar. Roll up progress from subtasks to parents automatically.

## 3. Recurring tasks

Support tasks that repeat on a schedule (daily, weekly, monthly, custom). Editing
a recurring instance can optionally update all future occurrences. Useful for
stand-ups, sprint ceremonies, and regular reviews.

## 4. Time-tracking / actual hours logged

Let team members log actual hours worked against estimated hours. Show a "logged
vs estimated" indicator in the hours panel and on task bars, highlighting over-runs
in red.

## 5. Notifications and reminders

Send email or browser notifications when a task's start date is approaching, when
a deadline is missed, or when a teammate modifies a task. Configurable per-project
and per-user.

## 6. Task comments and activity feed

Add a comment thread to each task so team members can discuss, post updates, and
attach files without leaving the planner. An activity feed on the project level
shows a chronological history of all changes.

## 7. Critical-path highlighting

Automatically calculate and visually highlight the critical path — the longest
chain of dependent tasks that determines the project end date. Bars on the
critical path could be shown with a distinct colour or border.

## 8. Milestones

Support zero-duration milestone markers on the timeline (e.g., "Release v1",
"Client sign-off"). Milestones appear as diamond shapes and can be linked to
dependency arrows like regular tasks.

## 9. Resource / workload view

Provide a per-person workload view that shows each team member's allocated hours
week by week. Colour-code rows green/amber/red based on utilisation versus
capacity, making it easy to spot over-allocation at a glance.

## 10. Baseline / snapshot comparison

Let users save a "baseline" of the current plan. The timeline can then display
both the baseline dates (ghost bars) and the current dates side-by-side so
schedule slippage is immediately visible.

## 11. Import from Microsoft Project / Excel

Add an import wizard that reads `.mpp`, `.xml` (MS Project XML), or a
well-defined `.xlsx` template and populates the Gantt chart automatically,
reducing the manual effort of migrating existing plans.

## 12. Public API / webhooks

Expose a REST API with authentication tokens so external tools (CI/CD pipelines,
project management bots, Slack integrations) can create, update, and query tasks
programmatically. Support outgoing webhooks on task events.

## 13. Dark mode

Add a dark colour scheme toggle (stored in user preferences) to reduce eye strain
during late-night planning sessions. Respect the OS `prefers-color-scheme` media
query as the default.

## 14. Customisable column visibility

Let users show or hide the task list columns (hours, dates, assignee, progress,
notes summary) and resize them by dragging column borders, similar to a
spreadsheet header row.

## 15. Multi-project Gantt overlay

Allow viewing tasks from multiple projects in the same timeline view. Each
project's tasks are colour-banded, giving a portfolio-level overview of how work
is distributed across teams.

## 16. Gantt chart print / export improvements

Add options to export the Gantt as a shareable PNG image (in addition to PDF),
and to export only the currently visible date range or a custom range. Include the
project name and generation date as a header in exports.

## 17. Tags and labels on tasks

Add free-form tags to tasks (e.g., "backend", "design", "blocker") with colour
coding. Provide filter controls in the toolbar to show only tasks matching one or
more tags, helping large teams focus on relevant work.

## 18. Mobile-friendly responsive layout

Optimise the application for touch screens and small viewports — e.g., hide the
sidebar behind a hamburger menu, use a vertically scrollable card list instead of
the full Gantt on phones, and replace hover tooltips with tap-friendly overlays.

## 19. Two-factor authentication (2FA)

Offer TOTP-based 2FA (Google Authenticator, Authy) as an optional security layer
for user accounts, protecting project data in shared-hosting deployments where
multi-tenant access is common.

## 20. Integrated time-zone and multi-language support

Allow each user to select their preferred time zone (important for distributed
teams) and UI language. Date formatting and week-start day should adapt to the
chosen locale, and the interface strings should be extracted into translation files
for easy localisation.
