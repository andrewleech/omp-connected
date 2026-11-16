#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-pptx>=0.6.23"]
# ///
"""Generate the PI-branded Smart Trolley fleet pitch from model results."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

HERE = Path(__file__).resolve().parent
RESULTS_PATH = HERE / "20261117_fleet-model-results.json"
CONTENT_PATH = HERE / "20261117_fleet-pitch-content.md"
PPTX_PATH = HERE / "20261117_fleet-pitch.pptx"
SCENARIOS = (("cautious", "Cautious"), ("target", "Target"), ("stretch", "Stretch"))
PI_DARK_BLUE = RGBColor(0, 59, 92)
WHITE = RGBColor(255, 255, 255)

SOURCES = {
    "baseline": "planning/fleets/20261116_smart-trolley-traditional-baseline.md",
    "anthropic": "https://www.anthropic.com/engineering/multi-agent-research-system",
    "shopify": "https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model",
    "stripe": "https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents",
    "uber": "https://www.uber.com/au/en/blog/solving-the-agent-identity-crisis/",
}


def num(value: float, digits: int = 1) -> str:
    return f"{value:,.{digits}f}"


def scenario(results: dict, key: str) -> dict:
    try:
        return results["scenarios"][key]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"Model results do not contain scenario {key!r}") from exc


def all_in_days(t: dict, role: str) -> float:
    return sum(float(t[f"{category}_{role}_days"]) for category in ("product", "setup", "coordination"))


def totals(result: dict) -> dict:
    return result["totals"]




def milestone_rows(result: dict) -> list[tuple[str, str]]:
    raw = result.get("milestones")
    if not isinstance(raw, (list, dict)):
        raise ValueError("Each scenario must include milestones as a list or mapping")
    labels = {
        "main_setup_complete": "Main setup complete",
        "target_commissioning_complete": "Required stations commissioned",
        "first_host_acceptance": "First host acceptance",
        "first_target_complete": "First target complete",
        "integration_target": "Integration target",
        "system_test_including_soak": "System test incl. soak",
        "dryout_including_observation": "Dry-out incl. observation",
        "sized_scope_complete": "30 sized packages + setup",
    }
    items = raw.items() if isinstance(raw, dict) else (
        (item.get("name", item.get("milestone", "Milestone")), item) for item in raw
    )
    rows: list[tuple[str, str]] = []
    for name, milestone in items:
        if name not in labels:
            continue
        if isinstance(milestone, dict):
            day = milestone.get("workday", milestone.get("workdays", milestone.get("day", milestone.get("time_workdays"))))
            label = milestone.get("label", labels.get(name, str(name).replace("_", " ").title()))
        else:
            day = milestone
            label = labels.get(name, str(name).replace("_", " ").title())
        if day is None:
            raise ValueError(f"Milestone {name!r} has no relative working-day time")
        rows.append((str(label), num(float(day), 1)))
    return sorted(rows, key=lambda row: float(row[1].replace(",", "")))


def summary_line(result: dict) -> str:
    summary = result.get("ticket_summary", {})
    if isinstance(summary, str):
        return summary
    if isinstance(summary, dict):
        return "; ".join(f"{key.replace('_', ' ')}: {value}" for key, value in summary.items())
    return str(summary)


def slide(index: int, template: int, body: str, notes: str, title: str, *placeholders: tuple[str, str]) -> str:
    parts = ["---", f"<!-- slide: {index}, template: {template} -->", "# title", title]
    for placeholder, text in placeholders:
        parts.extend((f"# {placeholder}", text))
    if body:
        parts.extend(("# body", body))
    parts.extend(("## notes", notes))
    return "\n".join(parts)


def content_for(results: dict, operator_days: float) -> str:
    target = scenario(results, "target")
    target_totals = totals(target)
    selected_milestones = milestone_rows(target)
    comparison_notes = (
        "All-in role totals are utilized effort forecasts: product effort plus one-off setup and recurring coordination. These comparisons are not automatic cash or staffing savings; operator effort is separate and has no recovered baseline for an operator saving. "
        "Traditional source schedule reports 101.4 Engineer days and 15.2 Principal days at 21.5 weeks; its headline rounds Engineer days to 101.5 and combined effort to 117 person-days. "
        "The baseline has different and unagreed staffing/focus, so this is a scenario comparison, not equal-resource empirical speedup. "
        "ERP, phone UI and release verification are unsized and excluded. Source: " + SOURCES["baseline"]
    )
    table1_notes = comparison_notes + " Model summaries: " + "; ".join(f"{key}: {summary_line(scenario(results, key))}" for key, _ in SCENARIOS)
    setup_principal_days = float(target_totals["setup_principal_days"])
    setup_days = float(target_totals["setup_engineer_days"])
    engineer_effort_delta = 101.4 - all_in_days(target_totals, "engineer")
    principal_effort_delta = 15.2 - all_in_days(target_totals, "principal")
    elapsed_cut = (1.0 - float(target["makespan_weeks"]) / 21.5) * 100
    target_week = float(target["makespan_weeks"])
    target_day = float(target["makespan_workdays"])
    ms_names = ", ".join(name for name, _ in selected_milestones)

    sections = [
        "# Smart Trolley fleet delivery proposal\n\n## Metadata\n- author: Andrew Leech\n- date: 17 November 2026\n",
        slide(1, 1, "", "Proposal only. No fleet has been commissioned and no delivery acceleration has been measured.", "Smart Trolley fleet [yellow]delivery[/yellow]", ("subtitle", "Executive proposal"), ("date", "17 November 2026"), ("author", "Andrew Leech"), ("client", "Exec / PM / software RGM")),
        slide(
            2, 15, "",
            f"Target: {num(target_day)} working days, {num(target_week)} weeks. "
            f"Engineer effort reduction {num(engineer_effort_delta)} days; Principal effort reduction {num(principal_effort_delta)} days. "
            f"Elapsed comparison {num(elapsed_cut)}% below the draft source schedule. "
            f"Setup E{num(setup_days)}/P{num(setup_principal_days)} is included once. "
            "These are judgement estimates, not measured performance or automatic cash/staffing savings. "
            "Human approval of every merge and a common initial decision allowance remain in the model. "
            "Three unsized tickets remain outside this pre-release-verification endpoint.",
            "Target forecast: testable [blue]hypothesis[/blue]",
            ("key_message", f"Target scenario\n{num(target_day)} working days\n{num(target_week)} weeks"),
            ("body", "- Parallel bounded implementation and cross-review\n- Dedicated target owners and explicit operator effort\n- Setup, human review and coordination included\n- Calibrate with the first delivery wave"),
        ),
        slide(3, 4, "Editable scenario table is added by the generator.", table1_notes, "Scenario [blue]comparison[/blue]"),
        slide(4, 4, "Editable milestone table is added by the generator.", "Milestones are evidence gates at relative working days from the modeled start, not calendar commitments. The final endpoint means 30 sized packages plus setup, before release verification. The table maps model milestone names to readable labels and retains relative workday offsets. No calendar dates are inferred. Hardware readiness, procurement and external decisions can shift actual availability. Preserve mandatory physical test durations. Model names: " + ms_names + ".", "Target [blue]milestones[/blue]"),
        slide(5, 5, "**Coordinator**\n- Maintains durable task/dependency state\n- Assigns ready work and resolves resource conflicts\n- Does not approve requirements or release", "", "Roles and [blue]accountability[/blue]", ("body_1", "**Delivery and assurance**\n- Deliverable workers own isolated bounded outputs and evidence\n- Independent reviewers are separate from producers\n- Stable hardware owners retain target authority and reservations")),
        slide(6, 5, "**ompc provides**\n- Agent/host discovery, messages, teams and session controls\n- Host session launch where supported\n- Session prompt queues and event visibility", "Existing ompc features are not a native project scheduler or durable task ledger. Mailboxes, events and session queues are not durable across all failures. Session launch leases do not reserve or lock physical hardware. Source: planning/fleets/20261116_fleet-research-and-capabilities.md.", "Use ompc; add project [blue]workflow[/blue]", ("body_1", "**Project workflow adds**\n- Versioned task contracts, dependencies and recovery records\n- Owned branches/worktrees and controlled integration\n- Independent review dispositions and revision-linked evidence\n- Stable target inventory, owners and enforced reservations")),
        slide(7, 4, "- **Read-only:** agents investigate; humans decide requirements and scope\n- **Supervised:** isolated implementation and independent review; human approves every merge\n- **Bounded automation:** only explicitly approved repeatable jobs and limits\n- **Consequential decisions:** human approval for safety, physical exceptions, acceptance and release\n\nStart with human review of every merge. Expand only named low-risk classes after evidence and approval.", "Proposed controls, not permissions currently granted. Independent agent review supports but does not replace human judgement. Human authority is required for requirements/interface choices, safety interpretations, physical-operation exceptions, consequential evidence acceptance and release. Sources: project execution and assurance plan; Stripe human merge review: " + SOURCES["stripe"] + "; Shopify executable verification: " + SOURCES["shopify"], "Assurance stays [blue]human-led[/blue]"),
        slide(8, 5, f"**Capacity assumptions**\n- One main hub/development computer\n- Optional distributed computers only where access/capacity needs them\n- Local GPU not assumed; model location/provider remains open\n- Slots/boards: 3/1, 6/2, 10/3 across scenarios; unconfirmed\n- Operator: {num(operator_days)} days at 0.25 FTE; additional, not counted as savings", "All primary scenarios use development-board readiness at workday 5, one prototype ready at workday 10 and one production fixture ready at workday 10. Scenario order is cautious/target/stretch: 3/6/10 agent slots and 1/2/3 basic development-board stations. One prototype and one fixture are shared across scenarios; stretch does not imply extra prototype trolleys. Setup effort covers the main environment and commissioning of boards, prototype and fixture once. Counts and dates remain unconfirmed. Operator effort is a separate forecast role with no recovered traditional baseline, so no operator saving is claimed. Session launch leases do not reserve hardware. Physical durations are not scenario-scaled. Source: planning/fleets/20261117_fleet-setup-ticket.md and planning/fleets/20261117_fleet-scenario-assumptions.json.", "Hardware is a [blue]constraint[/blue]", ("body_1", "**Preserve physical work**\n- Prototype dry-out confirmation and safe disconnect\n- Offline logging/replay and outage recovery\n- Every-channel commissioning, including forced faults\n- Integration, soak and release verification\n\nFleet concurrency does not shorten required physical tests or soak.")),
        slide(9, 5, "**Anthropic**\nParallel research orchestration is a decomposition precedent, not delivery evidence.\n- Reported 90.2% gain was on an internal research evaluation\n- It is not a coding-speed or project schedule claim\n- First-party report; different operating context", "Sources are mostly first-party company accounts, not independent comparative trials. Anthropic: " + SOURCES["anthropic"] + "; Shopify: " + SOURCES["shopify"] + "; Stripe: " + SOURCES["stripe"] + "; Uber attribution: " + SOURCES["uber"] + ". Use examples as operating precedents only; they do not establish this project's throughput, quality, cost or acceleration.", "Evidence informs the [blue]method[/blue]", ("body_1", "**Shopify and Stripe**\nShopify describes executable verification of proposed findings; Stripe describes human review before merge.\n\n**Apply here**\nTrack accepted outcomes, human touch time, review/integration wait, rework, defects, target occupancy and cost. One wave calibrates assumptions; it does not prove a project-wide acceleration factor.")),
        slide(10, 5, "**Forecast basis**\n- Role totals are utilized effort, not automatic cash savings\n- Setup and coordination are included once\n- Released capacity depends on actual allocation\n- Operator effort is separate; no baseline saving is claimed", "Rates, equipment quotes and model consumption costs are missing. The role days in the comparison are utilized effort forecasts, not cash savings or proof of reduced staffing. Variable-use cost basis: actual Engineer/Principal effort days × agreed role rates, plus operator_days × operator rate and equipment/model/operating costs. Booked full-window capacity envelope: makespan_workdays × assigned Engineer FTE × Engineer rate + makespan_workdays × assigned Principal FTE × Principal rate + makespan_workdays × 0.25 operator FTE × operator rate + equipment/model/operating costs. Baseline staffing/focus and charging basis are unagreed; do not claim savings until they are comparable.", "Economics: effort now, costs [blue]open[/blue]", ("body_1", "**Like-for-like limits**\n- Original 30 sized tickets only; 3 unsized tickets excluded\n- ERP link, phone UI and release verification remain unsized\n- AX-mini, ERP-side, PC recipe/fleet-view and air-generation software excluded\n- External decisions and hardware dates remain unknown\n\nA reduced estimate is not a full release forecast.")),
        slide(11, 4, "Editable sensitivity table is added by the generator.", "Each row changes one target assumption; values are calculated forecasts, not confidence percentiles. Human review, operator availability, physical duration and rework matter more than extra worker slots in this model. More workers do not establish more output. Machine capacity, provider quotas, real hardware dates and stakeholder decisions still need confirmation. ERP link, phone UI and release verification remain unsized, so no full product release date is shown.", "What moves the [blue]timeline[/blue]"),
        slide(12, 15, "", "Requested decision: agree a scenario and available capacity; name the coordinator, integration owner, independent reviewers and stable target owners; confirm the main computer and distinct board, prototype and fixture resources needed for the first wave; start bounded host-testable work, one integration/review cycle and target work when stations are commissioned; record observed effort, elapsed time, rework, waits, target occupancy and cost; revise the forecast from evidence. Do not approve an unqualified release date or claim measured acceleration.", "Decision [blue]requested[/blue]", ("key_message", "Agree the scenario, capacity, hardware and named ownership. Start one measured delivery wave."), ("body", "- Confirm target assumptions and missing costs\n- Name accountable decision and acceptance owners\n- Start host work while station setup proceeds\n- Reforecast using observed evidence")),
    ]
    return "\n".join(sections) + "\n"


def remove_shape(shape) -> None:
    element = shape._element
    element.getparent().remove(element)


def replace_body_with_table(slide_obj, rows: list[list[str]]) -> None:
    body_shape = next((shape for shape in slide_obj.shapes if shape.shape_id == 2 and shape.has_text_frame), None)
    if body_shape is None:
        raise ValueError("Template 4 slide has no body placeholder")
    left, top, width, height = body_shape.left, body_shape.top, body_shape.width, body_shape.height
    remove_shape(body_shape)
    table_shape = slide_obj.shapes.add_table(len(rows), len(rows[0]), left, top, width, height)
    table = table_shape.table
    table.autofit = False
    widths = [0.25, 0.18, 0.18, 0.17, 0.22] if len(rows[0]) == 5 else [0.72, 0.28]
    for col, fraction in enumerate(widths):
        table.columns[col].width = int(width * fraction)
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            cell = table.cell(r, c)
            cell.text = str(value)
            cell.margin_left = Inches(0.12)
            cell.margin_right = Inches(0.12)
            cell.margin_top = Inches(0.05)
            cell.margin_bottom = Inches(0.05)
            cell.fill.solid()
            cell.fill.fore_color.rgb = PI_DARK_BLUE if r == 0 else (RGBColor(232, 245, 250) if r % 2 else WHITE)
            for paragraph in cell.text_frame.paragraphs:
                paragraph.alignment = PP_ALIGN.LEFT
                for run in paragraph.runs:
                    run.font.name = "Calibri"
                    run.font.size = Pt(20 if r else 20)
                    run.font.bold = r == 0
                    run.font.color.rgb = WHITE if r == 0 else RGBColor(0, 0, 0)
    if len(rows[0]) == 5 and rows[-1][0].startswith("Note:"):
        table.cell(len(rows) - 1, 0).merge(table.cell(len(rows) - 1, len(rows[0]) - 1))


def set_minimum_font_sizes(prs: Presentation) -> None:
    for slide_index, slide_obj in enumerate(prs.slides):
        for shape in slide_obj.shapes:
            if not shape.has_text_frame or not shape.is_placeholder:
                continue
            if shape.placeholder_format.type in (PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.DATE, PP_PLACEHOLDER.SLIDE_NUMBER):
                continue
            is_key_message = slide_index in (1, 11) and shape.left < prs.slide_width / 2 and shape.top > Inches(2)
            is_title = shape.name.lower().startswith("title")
            for index, paragraph in enumerate(shape.text_frame.paragraphs):
                heading = index == 0 and len(paragraph.text.strip()) < 35 and ":" not in paragraph.text
                for run in paragraph.runs:
                    run.font.name = "Calibri"
                    if slide_index == 0 or is_title:
                        continue
                    run.font.size = Pt(36 if is_key_message else 24)
                    run.font.bold = bool(heading and not is_key_message)
                    run.font.color.rgb = WHITE if is_key_message else (
                        RGBColor(0, 161, 232) if heading else RGBColor(0, 0, 0))


def build(skill_dir: Path) -> None:
    if not RESULTS_PATH.is_file():
        raise FileNotFoundError(f"Required model results not found: {RESULTS_PATH.name}")
    template = skill_dir / "assets" / "PI_Template.pptx"
    builder = skill_dir / "scripts" / "build_from_content.py"
    if not template.is_file() or not builder.is_file():
        raise FileNotFoundError("--skill-dir must contain assets/PI_Template.pptx and scripts/build_from_content.py")
    with RESULTS_PATH.open(encoding="utf-8") as stream:
        results = json.load(stream)
    operator_days = float(totals(scenario(results, "target"))["operator_days"])
    CONTENT_PATH.write_text(content_for(results, operator_days), encoding="utf-8")
    subprocess.run([sys.executable, str(builder), str(CONTENT_PATH), str(template), str(PPTX_PATH)], check=True)
    prs = Presentation(PPTX_PATH)
    table_rows = [["Scenario", "Engineer effort days¹", "Principal effort days", "Elapsed weeks", "Basis"]]
    table_rows.append(["Traditional baseline", "101.4*", "15.2", "21.5", "Draft estimate"])
    table_rows.extend(
        [label, num(all_in_days(totals(scenario(results, key)), "engineer")),
         num(all_in_days(totals(scenario(results, key)), "principal")),
         num(float(scenario(results, key)["makespan_weeks"])), "Judgement estimate"]
        for key, label in SCENARIOS
    )
    table_rows.append([
        f"Note: E/P include setup and coordination. Baseline schedule is 101.4 E; headline rounds to 101.5. Operator effort {num(operator_days)} days/scenario; baseline not recorded. ERP, phone UI and release verification are unsized/excluded.",
        "", "", "", "",
    ])
    replace_body_with_table(prs.slides[2], table_rows)
    replace_body_with_table(prs.slides[3], [["Target gate", "Relative workday"]] + [[name, day] for name, day in milestone_rows(scenario(results, "target"))])
    def sensitivity_weeks(key, value):
        return num(next(item["makespan_weeks"] for item in results["sensitivities"][key] if item["value"] == value))
    sensitivity_rows = [
        ["Change from target", "Forecast weeks"],
        ["Human ticket review retains the original 15.2 Principal days", sensitivity_weeks("baseline_ticket_principal_days", 15.2)],
        ["Operator availability halved to 0.125 FTE", sensitivity_weeks("operator_fte", 0.125)],
        ["Human/execution allowances increased by 25%", num(results["target_contingency_1_25"]["makespan_weeks"])],
        ["Soak allowance increased from five to ten working days", sensitivity_weeks("system_soak_workdays", 10)],
        ["Execution slots increased to ten", sensitivity_weeks("agent_slots", 10)],
        ["ERP link, phone UI and release verification", "Unsized / excluded"],
    ]
    replace_body_with_table(prs.slides[10], sensitivity_rows)
    set_minimum_font_sizes(prs)
    prs.core_properties.author = "Andrew Leech"
    prs.core_properties.last_modified_by = "Andrew Leech"
    prs.core_properties.title = "Smart Trolley agent fleet delivery proposal"
    prs.core_properties.subject = "Planning forecast for 30 sized work packages plus fleet setup, before release verification"
    prs.save(PPTX_PATH)
    print(f"Generated {CONTENT_PATH}")
    print(f"Generated {PPTX_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-dir", required=True, type=Path, help="Path to the pi-pptx skill directory")
    args = parser.parse_args()
    build(args.skill_dir.expanduser().resolve())


if __name__ == "__main__":
    main()
