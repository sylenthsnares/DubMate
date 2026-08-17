<!-- antigravity-skill-orchestration:start -->
# Antigravity Project Agent Rules

These rules define how to use the project-local skills in `.agents/skills/`. Treat the skill files as the authoritative procedures: when a skill applies, read its `SKILL.md` before acting rather than relying on memory.

## Core principles

1. Follow the user's explicit request and scope first.
2. Preserve existing project architecture, conventions, design systems, and behavior unless the task requires changing them.
3. Use skills to improve reasoning and execution, not to add ceremony.
4. For tiny mechanical edits (typos, exact string replacements, obvious config-value changes, formatting-only changes), do the edit directly unless a skill's own trigger explicitly requires otherwise.
5. Do not claim success from code inspection alone. Completion requires fresh evidence appropriate to the task.

## Installed skills and responsibilities

### `brainstorming`
Use before creative or consequential implementation work: new features, behavior changes, architecture decisions, non-trivial refactors, new components, substantial UI changes, or ambiguous requirements.

Goals:
- Understand the desired outcome and constraints.
- Inspect relevant existing code before proposing a design.
- Identify meaningful alternatives and tradeoffs.
- Choose the smallest coherent approach that satisfies the request.
- Avoid coding a guessed solution before the problem is understood.

Do not expand the user's requested scope merely because brainstorming found additional ideas.

### `systematic-debugging`
Use when something is failing, inconsistent, unexplained, or regressed: test failures, build failures, runtime errors, broken UI behavior, integration problems, unexpected output, or a previous attempted fix did not work.

Rules:
- Diagnose before patching.
- Reproduce or gather evidence for the failure when possible.
- Trace the root cause rather than editing symptoms at random.
- Change one causal thing at a time when isolating a problem.
- After a fix, rerun the reproduction/check that demonstrated the failure.

Do not use speculative "try this and see" patch loops when evidence can be gathered first.

### `verification-before-completion`
Use before every substantive claim that work is complete, fixed, passing, ready, or successful.

Verification must be fresh and task-relevant. Depending on the project, this may include:
- targeted tests;
- broader tests when the change has wider impact;
- type checking;
- linting/static analysis;
- a production or development build;
- running the relevant application path;
- checking logs/output;
- browser or visual verification for UI work.

Never report a check as passing unless it was actually run in the current work and its result was observed. If a check cannot be run, state that clearly and distinguish verified facts from remaining uncertainty.

### `impeccable`
Use as the primary design-quality skill for substantial frontend/UI work.

Use it for:
- shaping new screens or flows;
- visual hierarchy and composition;
- spacing, typography, color, density, and responsive behavior;
- accessibility/design-quality audits;
- critiquing an existing interface;
- final UI polish and consistency;
- avoiding generic AI-generated visual patterns.

For the first substantial UI task in a project, inspect existing product/design context first. If Impeccable's expected design context is missing, follow the skill's initialization/documentation guidance before inventing a new visual language.

For maintenance tasks, preserve an established design system instead of "redesigning" the product without being asked.

### `emil-design-eng`
Use as the interaction-craft companion to Impeccable, especially for:
- motion and transitions;
- hover/press/focus states;
- menus, popovers, dialogs, drawers, tooltips, and toasts;
- drag/gesture behavior;
- perceived responsiveness;
- micro-interactions and component feel.

Do not add animation merely to make a UI look sophisticated. Prefer purposeful motion, respect reduced-motion/accessibility requirements, and keep frequently repeated interactions fast.

For mostly static layout/typography work, Impeccable is normally sufficient; do not force `emil-design-eng` into every UI task.

## Workflow

### A. New feature, behavior change, refactor, or substantial UI work

1. **Understand and inspect**
   - Read the request carefully.
   - Inspect the relevant code, nearby patterns, tests, and project conventions.
   - Avoid premature edits.

2. **Brainstorm when applicable**
   - Invoke/read `brainstorming`.
   - Resolve the design/implementation approach before coding.
   - Keep the plan proportional to task size.

3. **Apply domain guidance**
   - For non-UI work, proceed with project conventions after brainstorming.
   - For substantial UI work, invoke/read `impeccable`.
   - If interaction, animation, or micro-interaction quality matters, also invoke/read `emil-design-eng`.
   - When both UI skills apply, use Impeccable for macro visual/UX direction and Emil for interaction/motion craft.

4. **Implement**
   - Make the smallest complete set of changes.
   - Reuse existing abstractions and tokens where appropriate.
   - Do not introduce unrelated cleanup or dependencies without a clear reason.

5. **If anything fails, switch to debugging**
   - Invoke/read `systematic-debugging` before making a sequence of speculative fixes.
   - Establish root cause, fix it, and rerun the failing check.

6. **UI quality pass when applicable**
   - Review the finished UI with Impeccable's audit/critique/polish guidance as appropriate.
   - Review interaction and motion details with `emil-design-eng` when they are part of the change.
   - Fix meaningful issues found by the review; avoid churn for subjective changes that conflict with the product's established language.

7. **Verify before completion**
   - Invoke/read `verification-before-completion`.
   - Run the relevant checks after the final code change, including any post-polish edits.
   - For UI work, include visual/browser verification when the environment makes it possible.

8. **Report**
   - Summarize what changed.
   - Cite the checks actually run and their results.
   - Mention anything not verified, remaining risk, or follow-up only when it materially matters.

### B. Bug or failing check

1. Inspect the failure and relevant context.
2. Invoke/read `systematic-debugging`.
3. Reproduce or establish concrete evidence.
4. Identify root cause.
5. Implement the smallest causal fix.
6. Rerun the original failing check.
7. Run adjacent regression checks as warranted.
8. Invoke/read `verification-before-completion` before saying it is fixed.
9. If the bug is visual/UI-related, use Impeccable for design/a11y/responsive review and `emil-design-eng` when interaction or motion contributed to the issue.

### C. Small mechanical change

1. Confirm the target and make the exact requested change.
2. Run a proportionate check if the edit can affect behavior.
3. Use `verification-before-completion` before any substantive success claim.
4. Do not force brainstorming or UI critique onto trivial edits unless their own skill instructions require it.

## Conflict resolution

When instructions disagree, prefer this order:
1. User's explicit current request.
2. Safety/security constraints and repository policy.
3. Existing project requirements, tests, design system, and documented conventions.
4. This `AGENTS.md`.
5. The applicable skill instructions.
6. General preferences.

For UI-specific disagreements:
- Existing brand/design-system decisions beat generic taste rules unless the user asked for a redesign.
- Impeccable owns macro UX/visual-system decisions.
- `emil-design-eng` owns interaction and motion details.
- Accessibility, usability, performance, and reduced-motion needs beat decorative effects.

## Completion standard

"Done" means the requested scope is implemented and supported by fresh evidence. It does not mean "the code looks plausible."

Never:
- claim tests/build/lint passed without running them;
- hide a failing verification step;
- silently broaden scope;
- redesign established UI during an unrelated fix;
- add gratuitous animation;
- repeatedly guess at a bug without root-cause investigation.
<!-- antigravity-skill-orchestration:end -->

