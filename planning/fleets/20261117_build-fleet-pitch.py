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
    setup_principal_days = float(target_totals["setup_principal_days"])
    setup_days = float(target_totals["setup_engineer_days"])
    engineer_effort_delta = 101.4 - all_in_days(target_totals, "engineer")
    principal_effort_delta = 15.2 - all_in_days(target_totals, "principal")
    elapsed_cut = (1.0 - float(target["makespan_weeks"]) / 21.5) * 100
    target_week = float(target["makespan_weeks"])
    target_day = float(target["makespan_workdays"])
    comparison_notes = (
        "The comparison covers the same 30 sized work packages, with fleet setup added. "
        "Engineer and Principal effort includes setup and ongoing coordination. "
        f"Operator work adds {num(operator_days)} days; the source gives no operator effort baseline. "
        "The traditional estimate is 101.4 Engineer days and 15.2 Principal days. Its draft schedule is 21.5 weeks. "
        "The displayed ticket values sum to 101.5 Engineer days, and the rounded combined headline is 117 person-days. "
        "The source team and focus assumptions are unagreed, so elapsed comparisons remain provisional. "
        "ERP link, phone UI and release verification are unsized and excluded. Source: " + SOURCES["baseline"]
    )
    sections = [
        "# Smart Trolley fleet delivery proposal\n\n## Metadata\n- author: Andrew Leech\n- date: 17 November 2026\n",
        slide(
            1, 1, "",
            "I propose a project-specific agent fleet to reduce development effort and elapsed delivery time. "
            "The figures are forecasts awaiting calibration against project work; the fleet has not been commissioned.",
            "Smart Trolley fleet [yellow]delivery[/yellow]",
            ("subtitle", "Development proposal"), ("date", "17 November 2026"),
            ("author", "Andrew Leech"), ("client", "Exec / PM / software RGM"),
        ),
        slide(
            2, 15, "",
            f"The target is {num(target_day)} working days, or {num(target_week)} weeks, for the sized scope and setup. "
            f"Engineer effort falls by {num(engineer_effort_delta)} days and Principal effort by {num(principal_effort_delta)} days. "
            f"The elapsed forecast is {num(elapsed_cut)}% below the source's draft schedule. "
            f"One-off setup includes {num(setup_days)} Engineer days and {num(setup_principal_days)} Principal days. "
            "The plan retains human approval of every merge and an initial allowance for decisions.",
            "Target delivery [blue]forecast[/blue]",
            ("key_message", f"Target scenario\n{num(target_day)} working days\n{num(target_week)} weeks"),
            ("body", "- Parallel implementation with independent cross-review\n- Hardware agents run approved build/program/test cycles\n- Engineer decisions and human review retained\n- Setup and ongoing coordination included"),
        ),
        slide(
            3, 4, "Compare the sized scope, with fleet setup included.", comparison_notes,
            "Compare the delivery [blue]options[/blue]",
        ),
        slide(
            4, 4, "Acceptance gates use working days from the start of the plan.",
            "Each gate requires accepted evidence. The final gate covers 30 sized work packages and setup. "
            "Hardware supply, procurement and unresolved decisions can move the dates. "
            "Physical test durations remain subject to approval by the test authority.",
            "Target delivery [blue]milestones[/blue]",
        ),
        slide(
            5, 5,
            "**Coordination**\n- Keep task state and dependencies in shared records\n- Assign ready work and manage resource conflicts\n- Route scope and release decisions to human owners",
            "The project lead assigns the coordinator, integration owner, reviewers and hardware owners. "
            "Each worker owns a bounded deliverable, its branch and its evidence. "
            "The reviewer is separate from the producer. A stable hardware owner controls access to each station.",
            "Give each task an [blue]owner[/blue]",
            ("body_1", "**Delivery and review**\n- Workers own one deliverable and its evidence\n- A separate agent reviews each change\n- A named agent controls each hardware station"),
        ),
        slide(
            6, 5,
            "**ompc provides**\n- Find agents and sessions across machines\n- Send direct and team messages\n- Start and control sessions on connected, capable hosts\n- Queue prompts and inspect session events",
            "Use ompc's existing session and messaging functions. Host launch requires a capable connected extension and local control access. "
            "Keep task, evidence and reservation records outside the hub: its mailbox and event history are in memory. "
            "Queued prompts belong to the session and are lost when that session shuts down or changes conversation. "
            "Physical access needs its own reservation controls; ompc's launch leases cover sessions. "
            "Source: planning/fleets/20261116_fleet-research-and-capabilities.md.",
            "Use ompc for [blue]coordination[/blue]",
            ("body_1", "**Project workflow adds**\n- Record tasks, dependencies and decisions durably\n- Give workers separate worktrees and control integration\n- Record reviews, approvals and test evidence\n- Reserve identified hardware through its owner"),
        ),
        slide(
            7, 4,
            "- **Investigation:** agents gather evidence; humans decide requirements and scope\n"
            "- **Implementation:** agents build and cross-review; a human approves every merge\n"
            "- **Automation:** run only approved repeatable jobs within recorded limits\n"
            "- **Consequential decisions:** humans approve safety changes, physical exceptions, acceptance and release",
            "Any later exemption needs an approved low-risk change class, "
            "operating evidence and a way to withdraw that permission. Human authority covers requirements, interfaces, "
            "safety interpretations, physical-operation exceptions, consequential evidence acceptance and release. "
            "Agent checks provide evidence for those decisions. Sources: the execution and assurance plan; "
            "Stripe: " + SOURCES["stripe"] + "; Shopify: " + SOURCES["shopify"],
            "Keep [blue]people[/blue] accountable",
        ),
        slide(
            8, 5,
            "**Resources**\n- One main hub/development computer\n- Other computers where hardware access or capacity requires them\n"
            "- Cautious/target/stretch: 3/6/10 execution slots and 1/2/3 boards\n"
            f"- Operator: {num(operator_days)} days at 0.25 FTE",
            "The counts are planning assumptions. All three scenarios use boards ready at workday 5, one prototype ready at day 10 "
            "and one production fixture ready at day 10. Each station needs its own board, probe, peripherals and approved access. "
            "Extra sessions cannot share a target destructively. "
            "Setup is counted once. Local GPU inference is not assumed; check the chosen machine and provider capacity before committing. "
            "Active physical test and observation durations are the same in every primary scenario. "
            "Sources: planning/fleets/20261117_fleet-setup-ticket.md and planning/fleets/20261117_fleet-scenario-assumptions.json.",
            "Plan around the [blue]hardware[/blue]",
            ("body_1", "**Required checks**\n- Dry-out and fail-safe disconnect behaviour\n- Offline logging/replay and outage recovery\n- Every channel, including forced faults\n- Integration, soak and release verification\n\nRetain approved physical test durations."),
        ),
        slide(
            9, 5,
            "**Anthropic**\n- A lead agent delegates parallel research\n- Split work at useful task and context boundaries\n- Size the worker pool to independent work",
            "These are mainly first-party accounts. Anthropic's 90.2% result was an improvement on its internal research evaluation, "
            "not a coding-speed multiplier. Shopify describes tests that check proposed findings. Stripe retains human merge review. "
            "Use those practices and measure this project's results. Anthropic: " + SOURCES["anthropic"] +
            "; Shopify: " + SOURCES["shopify"] + "; Stripe: " + SOURCES["stripe"] +
            "; Uber's attribution chain: " + SOURCES["uber"] + ".",
            "Use the published [blue]lessons[/blue]",
            ("body_1", "**Shopify and Stripe**\n- Test proposed findings and reproduce uncertain results\n- Keep human review before merge\n- Track accepted work, rework, defects and cost"),
        ),
        slide(
            10, 5,
            "**Engineer capacity**\n- Count setup and coordination once\n- Use released time on other work\n- Price operator effort separately\n- Confirm rates, model spend and equipment quotes",
            "Price actual effort where people can use their remaining time elsewhere. If the project reserves them for the full window, "
            "price elapsed workdays times assigned FTE times the daily rate for each role. Add operator work, equipment and model/service costs. "
            "Confirm the source staffing, focus and charging basis before claiming a cash saving. "
            "The comparison excludes the unsized ERP link, phone UI and release verification. "
            "Original exclusions remain: AX-mini software, ERP-side software, PC recipe-authoring/fleet-view software and air-generation plant.",
            "Count [blue]effort[/blue] and cost separately",
            ("body_1", "**Cost basis**\n- Charge actual effort where capacity can be reused\n- Price the full allocation if people are reserved\n- Keep unsized work outside the savings comparison\n- Confirm external hardware and decision dates"),
        ),
        slide(
            11, 4, "Review effort, operator availability and physical duration drive the forecast.",
            "Each row changes one target assumption. These are sensitivity cases, not confidence percentiles. "
            "Extra worker slots alone do not shorten the modelled target schedule. "
            "Confirm machine capacity, provider quotas, physical readiness and stakeholder decisions before agreeing dates.",
            "What moves the [blue]timeline[/blue]",
        ),
        slide(
            12, 15, "",
            "Agree the working scenario and resource allocations. Assign the coordinator, integration owner, independent reviewers, "
            "hardware owners and human decision authorities. Confirm the main computer, target inventory and initial budget. "
            "Start bounded host work while stations are commissioned, then include a real target cycle. "
            "Record effort, elapsed time, rework, defects, waiting, target occupancy and cost. Update the remaining forecast from those results. "
            "The decision covers resources and the first wave. It sets no release date and claims no measured acceleration.",
            "Approve the first [blue]wave[/blue]",
            ("key_message", "Agree the resources and owners.\nStart the first delivery wave."),
            ("body", "- Assign decision, review and acceptance owners\n- Confirm machines, stations and budget\n- Start host work while station setup proceeds\n- Update the forecast from delivery results"),
        ),
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
    table_rows = [["Scenario", "Engineer days", "Principal days", "Elapsed weeks", "Basis"]]
    table_rows.append(["Traditional baseline", "101.4", "15.2", "21.5", "Draft estimate"])
    table_rows.extend(
        [label, num(all_in_days(totals(scenario(results, key)), "engineer")),
         num(all_in_days(totals(scenario(results, key)), "principal")),
         num(float(scenario(results, key)["makespan_weeks"])), "Forecast"]
        for key, label in SCENARIOS
    )
    table_rows.append([
        f"Note: Engineer/Principal totals include setup and coordination. Operator work adds {num(operator_days)} days; its source baseline is unavailable. ERP link, phone UI and release verification are unsized and excluded.",
        "", "", "", "",
    ])
    replace_body_with_table(prs.slides[2], table_rows)
    replace_body_with_table(prs.slides[3], [["Acceptance gate", "Working day"]] + [[name, day] for name, day in milestone_rows(scenario(results, "target"))])
    def sensitivity_weeks(key, value):
        return num(next(item["makespan_weeks"] for item in results["sensitivities"][key] if item["value"] == value))
    sensitivity_rows = [
        ["Change from target", "Forecast weeks"],
        ["Retain 15.2 Principal days for ticket review", sensitivity_weeks("baseline_ticket_principal_days", 15.2)],
        ["Halve operator availability to 0.125 FTE", sensitivity_weeks("operator_fte", 0.125)],
        ["Increase human/agent work allowances by 25%", num(results["target_contingency_1_25"]["makespan_weeks"])],
        ["Increase the soak allowance from five to ten working days", sensitivity_weeks("system_soak_workdays", 10)],
        ["Allow ten concurrent agent jobs", sensitivity_weeks("agent_slots", 10)],
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
