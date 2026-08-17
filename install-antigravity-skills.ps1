$ErrorActionPreference = "Stop"

# ============================================================
# Antigravity project skill installer
#
# Installs project-local skills into:
#   <project-root>\.agents\skills\
#
# Skills:
#   Superpowers:
#     - brainstorming
#     - systematic-debugging
#     - verification-before-completion
#   UI:
#     - impeccable
#     - emil-design-eng
#
# Also creates/updates a managed orchestration block in:
#   <project-root>\AGENTS.md
#
# Safe to rerun: installed skill folders are refreshed and only
# the managed block in AGENTS.md is replaced.
# ============================================================

function Assert-LastExitCode {
    param([string]$Message)
    if ($LASTEXITCODE -ne 0) {
        throw "$Message (exit code $LASTEXITCODE)"
    }
}

function Copy-Skill {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $true)][string]$SkillName
    )

    $SkillFile = Join-Path $Source "SKILL.md"
    if (-not (Test-Path $SkillFile)) {
        throw "Could not find SKILL.md for '$SkillName' at '$Source'."
    }

    $Target = Join-Path $DestinationRoot $SkillName

    if (Test-Path $Target) {
        Remove-Item -Recurse -Force $Target
    }

    Copy-Item -Path $Source -Destination $Target -Recurse -Force

    $InstalledSkillFile = Join-Path $Target "SKILL.md"
    if (-not (Test-Path $InstalledSkillFile)) {
        throw "Installation verification failed for '$SkillName'."
    }

    Write-Host "  [OK] $SkillName"
}

function Clone-Sparse {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string[]]$Paths
    )

    & git clone --depth 1 --filter=blob:none --sparse $Repo $Destination
    Assert-LastExitCode "Failed to clone $Repo"

    & git -C $Destination sparse-checkout set @Paths
    Assert-LastExitCode "Failed to configure sparse checkout for $Repo"
}

# ------------------------------------------------------------
# Locate project root
# ------------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or is not available in PATH."
}

try {
    $GitRoot = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and $GitRoot) {
        $ProjectRoot = $GitRoot.Trim()
    }
    else {
        $ProjectRoot = (Get-Location).Path
    }
}
catch {
    $ProjectRoot = (Get-Location).Path
}

$SkillsDestination = Join-Path $ProjectRoot ".agents\skills"
$AgentsFile = Join-Path $ProjectRoot "AGENTS.md"

New-Item -ItemType Directory -Force -Path $SkillsDestination | Out-Null

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("antigravity-skills-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

$SuperpowersRepo = "https://github.com/obra/superpowers.git"
$EmilRepo       = "https://github.com/emilkowalski/skills.git"
$ImpeccableRepo = "https://github.com/pbakaus/impeccable.git"

$SuperpowersDir = Join-Path $TempRoot "superpowers"
$EmilDir        = Join-Path $TempRoot "emil-skills"
$ImpeccableDir  = Join-Path $TempRoot "impeccable"

Write-Host ""
Write-Host "Antigravity Project Skills Installer"
Write-Host "===================================="
Write-Host "Project root : $ProjectRoot"
Write-Host "Skills path  : $SkillsDestination"
Write-Host "Rules file   : $AgentsFile"
Write-Host ""

try {
    # --------------------------------------------------------
    # 1) Superpowers: universal engineering workflow
    # --------------------------------------------------------
    Write-Host "Downloading Superpowers skills..."

    $SuperpowerSkills = @(
        "brainstorming",
        "systematic-debugging",
        "verification-before-completion"
    )

    $SuperpowerPaths = $SuperpowerSkills | ForEach-Object { "skills/$_" }

    Clone-Sparse `
        -Repo $SuperpowersRepo `
        -Destination $SuperpowersDir `
        -Paths $SuperpowerPaths

    Write-Host "Installing Superpowers skills..."
    foreach ($Skill in $SuperpowerSkills) {
        Copy-Skill `
            -Source (Join-Path $SuperpowersDir "skills\$Skill") `
            -DestinationRoot $SkillsDestination `
            -SkillName $Skill
    }

    # --------------------------------------------------------
    # 2) Emil Kowalski: design engineering / interaction craft
    # --------------------------------------------------------
    Write-Host ""
    Write-Host "Downloading Emil Kowalski design-engineering skill..."

    Clone-Sparse `
        -Repo $EmilRepo `
        -Destination $EmilDir `
        -Paths @("skills/emil-design-eng")

    Write-Host "Installing design-engineering skill..."
    Copy-Skill `
        -Source (Join-Path $EmilDir "skills\emil-design-eng") `
        -DestinationRoot $SkillsDestination `
        -SkillName "emil-design-eng"

    # --------------------------------------------------------
    # 3) Impeccable: primary UI design-quality skill
    # --------------------------------------------------------
    Write-Host ""
    Write-Host "Downloading Impeccable..."

    # Impeccable currently publishes a native .agents build.
    Clone-Sparse `
        -Repo $ImpeccableRepo `
        -Destination $ImpeccableDir `
        -Paths @(".agents/skills/impeccable")

    Write-Host "Installing Impeccable..."
    Copy-Skill `
        -Source (Join-Path $ImpeccableDir ".agents\skills\impeccable") `
        -DestinationRoot $SkillsDestination `
        -SkillName "impeccable"

    # --------------------------------------------------------
    # 4) Create/update AGENTS.md orchestration rules
    # --------------------------------------------------------
    Write-Host ""
    Write-Host "Creating/updating AGENTS.md workflow rules..."

    $StartMarker = "<!-- antigravity-skill-orchestration:start -->"
    $EndMarker   = "<!-- antigravity-skill-orchestration:end -->"

    $ManagedBlock = @'
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
'@

    if (Test-Path $AgentsFile) {
        $Existing = Get-Content -Raw -Path $AgentsFile
        $Pattern = "(?s)" + [regex]::Escape($StartMarker) + ".*?" + [regex]::Escape($EndMarker)

        if ([regex]::IsMatch($Existing, $Pattern)) {
            $Updated = [regex]::Replace(
                $Existing,
                $Pattern,
                [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $ManagedBlock }
            )
        }
        else {
            $Updated = $Existing.TrimEnd() + "`r`n`r`n" + $ManagedBlock + "`r`n"
        }
    }
    else {
        $Updated = $ManagedBlock + "`r`n"
    }

    Set-Content -Path $AgentsFile -Value $Updated -Encoding UTF8

    if (-not (Test-Path $AgentsFile)) {
        throw "Failed to create AGENTS.md."
    }

    Write-Host "  [OK] AGENTS.md"

    # --------------------------------------------------------
    # Final verification
    # --------------------------------------------------------
    Write-Host ""
    Write-Host "Verifying installed skills..."

    $ExpectedSkills = @(
        "brainstorming",
        "systematic-debugging",
        "verification-before-completion",
        "impeccable",
        "emil-design-eng"
    )

    foreach ($Skill in $ExpectedSkills) {
        $SkillMd = Join-Path $SkillsDestination "$Skill\SKILL.md"
        if (-not (Test-Path $SkillMd)) {
            throw "Missing expected skill after installation: $Skill"
        }
        Write-Host "  [OK] .agents\skills\$Skill\SKILL.md"
    }

    Write-Host ""
    Write-Host "===================================="
    Write-Host "Installation complete."
    Write-Host "===================================="
    Write-Host ""
    Write-Host "Installed 5 project-local skills and updated AGENTS.md."
    Write-Host ""
    Write-Host "Recommended next step for a UI project:"
    Write-Host "  Start a new Antigravity agent conversation so workspace"
    Write-Host "  rules and skills are discovered from a fresh session."
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Error "Installation failed: $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path $TempRoot) {
        Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
    }
}
