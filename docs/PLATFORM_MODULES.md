# Platform Modules

These modules are intentionally **post-core**. They should grow around the Codex workspace without turning the first release into a dashboard project.

The common rule: every module may be global, project-scoped, or both, but Projects remain the main daily navigation.

## Notes

Purpose: capture context the user wants to keep without polluting Codex chat.

Suggested capabilities:

- global notes;
- project notes;
- lightweight Markdown;
- pin important note;
- link a note to a thread/result/project;
- quick-create from selected Result or chat turn later;
- search/filter later.

Example:

```text
Notes
  Global
    Server setup
    UI ideas

  Case Maker
    Export quirks
    MCP ideas
```

Keep Notes simple. It is not Notion.

## Plan / Tasks

Purpose: remember what should happen next across projects.

Suggested task fields:

```text
id
title
description?
projectId?
status: todo | doing | blocked | done
priority?
dueAt?
linkedThreadId?
createdAt
updatedAt
```

Useful views:

- Today / Next;
- by project;
- currently Doing;
- recently completed.

A future integration can create a Codex thread from a task or link the active thread to a task.

Keep it lightweight rather than implementing a full Jira/kanban suite.

## Machines

Purpose: make infrastructure understandable when something is unavailable.

Machine card may show:

```text
Main PC                         ONLINE
Windows

Codex       ready / version
Remote      available
CPU         17%
Memory      8.4 / 32 GB
Disk        384 / 1000 GB
Last seen   now
```

Data should be low-frequency/cached. Do not hammer the machine with telemetry polling.

Useful actions later:

- test SSH;
- refresh status;
- show diagnostics;
- open projects on this machine;
- open Remote;
- restart a stuck Hub-owned Codex App Server session.

Do not add generic remote administration controls casually.

## Project overview

A project home/summary page may eventually combine:

- active/recent Codex thread;
- latest Results;
- pinned note;
- current Plan items;
- Git branch/status;
- machine state.

This can become the useful 'dashboard' seen in visual references, but only after each underlying module is real.

## Files

Purpose: inspect what Codex changed/generated without opening Remote.

Preferred scope:

- changed files first;
- project tree later;
- read-only text preview;
- image/artifact preview;
- download;
- open diff;
- copy path.

Do not make a full web source editor a prerequisite.

## Git

Purpose: answer basic project questions quickly.

Potential information:

- current branch;
- dirty/clean;
- changed file count;
- ahead/behind when cheap to determine;
- recent commits;
- diff viewer.

Potential actions should be added conservatively. Reading state is more important than reproducing a full Git client.

## Activity

Purpose: debugging and detailed execution history.

Activity can include:

- Codex tool events;
- commands/builds;
- machine reconnects;
- Remote connect/disconnect;
- result creation;
- application-level errors.

This is separate from Results: Activity is exhaustive-ish and technical; Results is curated and useful.

## Results library

Later, allow project-level browsing outside one thread:

```text
Case Maker / Results
  Images
  Builds
  Artifacts
  Diffs
```

This is especially useful for CAD/UI/image-heavy work where visual versions matter.

## Pinned items

A generic Pin model can eventually point at:

- note;
- task;
- result;
- Codex thread;
- file/artifact.

Pins can power a compact project overview without duplicating content.

## Search

Do not build global search early, but choose IDs/data models that make it possible later.

Potential searchable Hub-owned content:

- project names;
- thread titles/mappings;
- notes;
- tasks;
- result metadata;
- activity metadata.

Avoid indexing entire private source trees in the Hub unless there is a concrete need.

## Module navigation on iPad

Possible mature left navigation:

```text
PROJECTS
  Case Maker
  AltarProject
  Reader

WORKSPACE
  Notes
  Plan
  Machines

SETTINGS
```

When a Project is active, its threads remain visible and global modules may default-filter to that project.

## Development rule

Implement these modules one at a time based on actual use.

A good module must either:

1. reduce the need to open Remote Desktop;
2. preserve context that would otherwise be lost;
3. make it faster to decide what to do next.

If it does none of those, it probably does not belong in the platform yet.
