#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic planning estimate and resource schedule for trolley fleet work."""
from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "20261117_traditional-ticket-inputs.json"
ESTIMATES = ROOT / "20261117_fleet-work-package-estimates.json"
ASSUMPTIONS = ROOT / "20261117_fleet-scenario-assumptions.json"
RESULTS = ROOT / "20261117_fleet-model-results.json"
REPORT = ROOT / "20261117_fleet-estimate-and-schedule.md"
CSV_PATH = ROOT / "20261117_fleet-task-schedule.csv"
BASELINE_E, BASELINE_P, BASELINE_WEEKS = 101.4, 15.2, 21.5

# Explicit one-to-one crosswalk from target work-package IDs to recovered source card IDs.
TICKET_SOURCE_IDS = {
    "scheduler":"tk-scheduler", "host-simulation":"tk-host-sim", "sensor-drivers":"tk-drv-sensors",
    "actuator-drivers":"tk-drv-actuators", "storage":"tk-storage", "misc-io":"tk-drv-misc",
    "bringup":"tk-bringup", "ota":"tk-ota", "pressure":"tk-pressure-loop", "vpd":"tk-vpd",
    "irrigation":"tk-irrigation", "low-media":"tk-low-media", "zone-config":"tk-zone-config",
    "swap":"tk-swap-mode", "recipes":"tk-recipe-engine", "lighting":"tk-lighting",
    "recipe-store":"tk-recipe-store", "disconnect":"tk-disconnect", "resume":"tk-resume",
    "identity":"tk-identity", "alarms":"tk-alarms", "events":"tk-events", "api":"tk-rest-api",
    "pairing":"tk-pairing", "self-test":"tk-selftest", "provisioning":"tk-provisioning",
    "integration":"tk-integration", "system-test":"tk-system-test", "dry-out":"tk-dryout",
    "release-records":"tk-release-notes",
}


def check(ok, message):
    if not ok:
        raise AssertionError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def get_source(source):
    rows = source["tickets"]
    check(len(rows) == 33, f"Expected 33 extracted source cards, found {len(rows)}")
    by_id = {}
    for row in rows:
        sid = row.get("source_id")
        check(sid and sid not in by_id, f"Missing or duplicate source ticket ID: {sid!r}")
        by_id[sid] = row
    check(len(set(TICKET_SOURCE_IDS.values())) == 30, "Duplicate source ticket mapping")
    check(set(TICKET_SOURCE_IDS.values()) <= by_id.keys(), "Mapped source ticket ID missing")
    mapped = set(TICKET_SOURCE_IDS.values())
    excluded = [r for sid, r in by_id.items() if sid not in mapped]
    check(len(excluded) == 3, f"Expected exactly 3 unsized exclusions, found {len(excluded)}")
    for row in excluded:
        check(row.get("engineer_days") is None, f"Unsized card has Engineer days: {row['source_id']}")
    return by_id, excluded


def make_graph(source_by_id):
    source_to_model={sid:mid for mid,sid in TICKET_SOURCE_IDS.items()}
    full={sid:list(row.get("dependencies",[])) for sid,row in source_by_id.items()}
    for sid,deps in full.items():
        for dep in deps:
            check(dep in source_by_id,f"Unknown dependency {dep!r} on {sid}")
    visiting,visited=set(),set()
    def visit(sid):
        check(sid not in visiting,f"Dependency cycle at source ticket {sid}")
        if sid in visited:return
        visiting.add(sid)
        for dep in full[sid]:visit(dep)
        visiting.remove(sid);visited.add(sid)
    for sid in full:visit(sid)
    graph={mid:[] for mid in TICKET_SOURCE_IDS}
    excluded_edges={}
    for mid,sid in TICKET_SOURCE_IDS.items():
        check(source_by_id[sid].get("hardware_class") in ("Before hardware","With hardware"),
              f"Missing hardware class for {sid}")
        for dep in full[sid]:
            if dep in source_to_model: graph[mid].append(source_to_model[dep])
            else: excluded_edges.setdefault(mid,[]).append(dep)
    return graph,excluded_edges


def source_days(row):
    value = row.get("engineer_days")
    if value is None:
        found = re.search(r"/\s*([0-9.]+)\s*days", str(row.get("estimate", "")))
        check(found is not None, f"No displayed Engineer days on source card {row['source_id']}")
        value = found.group(1)
    return float(value)


def schedule_scenario(name, scenario, estimates, assumptions, source_by_id, graph, overrides=None, contingency=1.0):
    p = dict(scenario)
    p.update(overrides or {})
    p.setdefault("physical_resources", {})
    phys = dict(assumptions["physical_resources"])
    phys.update(p.pop("physical_resources", {}))
    p["physical_resources"]=dict(phys)
    rows = {r[0]:r for r in estimates["rows"]}
    check(set(rows) == set(TICKET_SOURCE_IDS) and len(rows) == 30,
          "Target estimate rows must map uniquely to all 30 source tickets")
    station_types = estimates["station_type_by_model_id"]
    operator_days = estimates["operator_days_by_model_id"]
    check(set(station_types) == set(operator_days), "Target station and operator mappings differ")
    check(set(station_types) == {k for k,r in rows.items() if float(r[6]) > 0},
          "Every target-work row must have exactly one station type and operator estimate")
    valid_station_types = {"dev_board", "prototype", "production_fixture"}
    check(set(station_types.values()) <= valid_station_types, "Unknown target station type")
    ids = {sid:mid for mid,sid in TICKET_SOURCE_IDS.items()}
    for tid, sid in TICKET_SOURCE_IDS.items():
        check(source_by_id[sid].get("hardware_class") != "With hardware" or tid == "bringup" or
              float(rows[tid][6]) > 0, f"With-hardware ticket missing target acceptance: {sid}")
    agent_n = int(p["agent_slots"])
    counts = {"dev_board":int(p["target_slots"]), "prototype":int(phys["prototype_slots"]),
              "production_fixture":int(phys["production_fixture_slots"])}
    check(agent_n > 0 and all(v > 0 for v in counts.values()), "Resource slot counts must be positive")
    reserve = assumptions["recurring_fleet_coordination"]
    assigned_e, assigned_p = float(p["engineer_fte"]), float(p["principal_fte"])
    reserve_e, reserve_p = float(reserve["engineer_fte_reserved"]), float(reserve["principal_fte_reserved"])
    e_fte, p_fte = assigned_e-reserve_e, assigned_p-reserve_p
    op_fte = float(phys["operator_fte"])
    check(e_fte > 0 and p_fte > 0 and op_fte > 0, "Human assigned FTE must exceed reserve")
    exec_mul = float(p["execution_multiplier"])*contingency
    human_mul = float(p["human_multiplier"])*contingency
    principal_mul = float(assumptions["human_review_policy"]["principal_review_estimate_multiplier"])
    principal_mul *= max(float(assumptions["human_review_policy"]["minimum_review_human_multiplier"]), human_mul)
    # Phase tasks have calendar duration and effort tracked separately. Human effort is divided
    # by effective phase FTE; agent and physical work occupies slot-days directly.
    tasks, phases = {}, defaultdict(dict)
    def add(key, ticket, phase, pool, effort, multiplier=1.0, fte=1.0, preds=(), release=0.0, kind="ticket"):
        effort = float(effort)*multiplier
        pools = tuple(pool) if isinstance(pool, (list, tuple, set)) else (() if pool is None else (pool,))
        tasks[key] = {"ticket":ticket,"phase":phase,"pool":pools,"effort":effort,
                      "duration":effort/fte,"pred":set(preds),"release":float(release),"kind":kind}
        return key
    setup = assumptions["setup_target_estimates"]
    check(round(sum(a["engineer_days"] for a in setup["activities"]),2)==float(setup["main_environment"]["engineer_days"]),
          "Setup activity Engineer sum does not match aggregate")
    check(round(sum(a["principal_days"] for a in setup["activities"]),2)==float(setup["main_environment"]["principal_days"]),
          "Setup activity Principal sum does not match aggregate")
    setup_nodes={}
    host_setup=[]; target_setup=[]
    for activity in setup["activities"]:
        aid=activity["id"]
        activity_keys=[]
        for phase, effort, pool, mult, fte in (
            ("engineer",activity["engineer_days"],"engineer",human_mul,e_fte),
            ("agent",activity["agent_execution_days"],"agent",exec_mul,1.0),
            ("principal",activity["principal_days"],"principal",human_mul,p_fte)):
            if float(effort)==0: continue
            key=f"setup:{aid}:{phase}"
            preds=[]
            if phase!="engineer" and f"setup:{aid}:engineer" in tasks:
                preds.append(f"setup:{aid}:engineer")
            if phase=="principal" and f"setup:{aid}:agent" in tasks:
                preds.append(f"setup:{aid}:agent")
            if activity["gate"]=="after-first-wave":
                preds.append("host-simulation:host_acceptance")
            add(key,"setup",f"{aid}_{phase}",pool,effort,mult,fte,preds,
                release=float(p["main_computer_ready_workday"]),kind="setup")
            activity_keys.append(key)
        gate=f"setup:{aid}:complete"
        tasks[gate]={"ticket":"setup","phase":f"{aid}_complete","pool":(),"effort":0.0,"duration":0.0,
                     "pred":set(activity_keys),"release":0.0,"kind":"gate"}
        setup_nodes[aid]=gate
        if activity["gate"]=="host": host_setup.append(gate)
        if activity["gate"]=="target": target_setup.append(gate)
    host_setup_complete="setup:host_ready"
    tasks[host_setup_complete]={"ticket":"setup","phase":"host_ready","pool":(),"effort":0.0,"duration":0.0,
                               "pred":set(host_setup),"release":0.0,"kind":"gate"}
    full_setup_complete="setup:all_complete"
    tasks[full_setup_complete]={"ticket":"setup","phase":"all_complete","pool":(),"effort":0.0,"duration":0.0,
                               "pred":set(setup_nodes.values()),"release":0.0,"kind":"gate"}
    ready_by_type={"dev_board":float(phys["dev_board_ready_workday"]),
                   "prototype":float(phys["prototype_ready_workday"]),
                   "production_fixture":float(phys["production_fixture_ready_workday"])}
    station_setup_by_slot=defaultdict(set)
    for stype,n in counts.items():
        for index in range(n):
            for phase,effort,pool,mult,fte in (
                ("engineer",setup["per_target_station"]["engineer_days"],"engineer",human_mul,e_fte),
                ("principal",setup["per_target_station"]["principal_days"],"principal",human_mul,p_fte),
                ("agent",setup["per_target_station"]["agent_execution_days"],"agent",exec_mul,1.0)):
                key=f"setup:{stype}-{index+1}:{phase}"
                preds=list(target_setup)
                if phase!="engineer": preds.append(f"setup:{stype}-{index+1}:engineer")
                add(key,f"{stype}-{index+1}","station_commissioning_"+phase,pool,effort,mult,fte,
                    preds,ready_by_type[stype],"setup")
                station_setup_by_slot[stype,index].add(key)
    for tid, sid in TICKET_SOURCE_IDS.items():
        _, _, ed, pd, agent_effort, review_effort, target_active, _ = rows[tid]
        target_active=float(target_active)
        target_exists=target_active>0
        host_share=.50 if target_exists else .75
        brief=add(f"{tid}:briefing",tid,"briefing","engineer",ed*.25,human_mul,e_fte,
                  [host_setup_complete],max(float(p["main_computer_ready_workday"]),
                  float(p.get("decision_latency_workdays",assumptions["decision_latency_workdays"]))))
        prod=add(f"{tid}:production",tid,"production","agent",agent_effort,exec_mul,preds=[brief])
        review=add(f"{tid}:review",tid,"review","agent",review_effort,exec_mul,preds=[prod])
        host=add(f"{tid}:host_acceptance",tid,"host_acceptance","engineer",ed*host_share,human_mul,e_fte,[prod,review])
        principal=add(f"{tid}:principal_review",tid,"principal_review","principal",pd,principal_mul,p_fte,[review])
        tasks[host]["pred"].add(principal)
        phases[tid].update(briefing=brief,production=prod,review=review,host_acceptance=host,principal_review=principal)
        if target_exists:
            stype=station_types[tid]
            station_preds=station_setup_by_slot[stype,0]
            station_ready=ready_by_type[stype]
            release=station_ready
            active_duration=target_active
            fixed=0.0
            if tid=="system-test": fixed=float(assumptions["fixed_physical_duration_allowances"]["system_soak_workdays"])
            if tid=="dry-out": fixed=float(assumptions["fixed_physical_duration_allowances"]["dry_out_observation_workdays"])
            oper=add(f"{tid}:operator_validation",tid,"operator_validation",[stype,"operator"],
                     operator_days[tid],fte=op_fte,preds=[host],release=release)
            tasks[oper]["pred"].update(station_preds)
            target_task=add(f"{tid}:target_validation",tid,"target_validation",None,active_duration+fixed,
                            preds=[host,oper],release=release,kind="ticket")
            tasks[target_task]["pred"].update(station_preds)
            tasks[target_task]["active_days"]=active_duration
            tasks[target_task]["fixed_observation_days"]=fixed
            tasks[oper]["station_type"]=stype
            tasks[oper]["reservation_tail"]=active_duration+fixed
            tasks[target_task]["reservation_owner"]=oper
            e_target=add(f"{tid}:engineer_target_acceptance",tid,"engineer_target_acceptance","engineer",
                         ed*.25,max(1.0,human_mul),e_fte,preds=[target_task,oper])
            station_gate=add(f"{tid}:target_acceptance",tid,"target_acceptance",None,0,preds=[e_target])
            phases[tid].update(target_validation=target_task,operator_validation=oper,
                               engineer_target_acceptance=e_target,target_acceptance=station_gate)
            phases[tid]["complete"]=station_gate
        else:
            phases[tid]["complete"]=host
        phases[tid]["host_milestone"]=host
    # Source dependencies release at host acceptance unless the source card is With hardware.
    for tid in TICKET_SOURCE_IDS:
        for dep in graph[tid]:
            dep_sid=TICKET_SOURCE_IDS[dep]
            dep_row=source_by_id[dep_sid]
            milestone=phases[dep]["complete"] if dep_row["hardware_class"]=="With hardware" else phases[dep]["host_milestone"]
            tasks[phases[tid]["briefing"]]["pred"].add(milestone)
    # Integrated target acceptance needs each named functional feature target check.
    functional=["sensor-drivers","actuator-drivers","ota","pressure","vpd","irrigation","low-media",
                "zone-config","swap","recipes","lighting","disconnect","resume","api","pairing",
                "alarms","events","self-test","dry-out"]
    tasks[phases["integration"]["target_validation"]]["pred"].update(phases[t]["complete"] for t in functional)
    # Soak runs on integrated target revision; system target is held through soak. Dry-out holds
    # its prototype station through the fixed observation. Operator effort is separate capacity.
    tasks[phases["system-test"]["target_validation"]]["pred"].add(phases["integration"]["complete"])
    for ph in phases.values():
        if "target_validation" in ph:
            operator=tasks[ph["operator_validation"]]
            operator["pred"].update(tasks[ph["target_validation"]]["pred"]-{ph["operator_validation"]})

    capacities={"engineer":(1,e_fte),"principal":(1,p_fte),"agent":(agent_n,1.0),
                "operator":(1,op_fte),"dev_board":(counts["dev_board"],1.0),
                "prototype":(counts["prototype"],1.0),"production_fixture":(counts["production_fixture"],1.0)}
    calendars={pool:[[] for _ in range(n)] for pool,(n,_) in capacities.items()}
    result={}; remaining=set(tasks)
    def earliest(pools,ready,durations):
        if not pools:return ready,()
        best=None
        def availability(pool,slot,start):
            duration=durations[pool]
            for a,b,_ in sorted(calendars[pool][slot]):
                if start+duration<=a+1e-10: break
                if start<b-1e-10: start=b
            return start
        import itertools
        for slots in itertools.product(*(range(capacities[pool][0]) for pool in pools)):
            if any(pool in valid_station_types and not station_setup_by_slot[pool,slot]<=result.keys()
                   for pool,slot in zip(pools,slots)):
                continue
            start=ready
            for pool,slot in zip(pools,slots):
                if pool in valid_station_types:
                    start=max(start,max(result[k]["finish"] for k in station_setup_by_slot[pool,slot]))
            while True:
                adjusted=max(availability(pool,slot,start) for pool,slot in zip(pools,slots))
                if adjusted<=start+1e-10:break
                start=adjusted
            candidate=(start,slots)
            if best is None or candidate<best:best=candidate
        return best if best is not None else (float("inf"),())
    successors={key:[] for key in tasks}
    for key,task in tasks.items():
        for predecessor in task["pred"]:
            check(predecessor in tasks, f"Unknown predecessor {predecessor}")
            successors[predecessor].append(key)
    priority_memo={}
    priority_visiting=set()
    def downstream(key):
        if key not in priority_memo:
            check(key not in priority_visiting, "Schedule graph has a cycle")
            priority_visiting.add(key)
            priority_memo[key]=tasks[key]["duration"]+max(
                (downstream(child) for child in successors[key]),default=0.0)
            priority_visiting.remove(key)
        return priority_memo[key]
    while remaining:
        ready_keys=[k for k in remaining if tasks[k]["pred"]<=result.keys()]
        check(ready_keys,"Schedule graph has a cycle or unresolved predecessor")
        candidates=[]
        for key in ready_keys:
            task=tasks[key]
            release=max([result[x]["finish"] for x in task["pred"]]+[task["release"],0.0])
            durations={pool:task["duration"] for pool in task["pool"]}
            if "reservation_tail" in task:
                durations[task["station_type"]]+=task["reservation_tail"]
            start,slots=earliest(task["pool"],release,durations)
            commissioning_priority=0 if task["phase"].startswith("station_commissioning_") else 1
            candidates.append((start,commissioning_priority,-downstream(key),key,slots,release))
        start,_,_,key,slots,release=min(candidates)
        check(start<float("inf"),"No commissioned physical station can accept ready work")
        task=tasks[key]; finish=start+task["duration"]; pools=task["pool"]
        resource="+".join(f"{pool}-{slot+1}" if capacities[pool][0]>1 or pool in valid_station_types else pool
                          for pool,slot in zip(pools,slots)) or "gate"
        if "reservation_owner" in task:
            resource=result[task["reservation_owner"]]["station_reservation"]["resource"]
        result[key]={"ticket":task["ticket"],"phase":task["phase"],"start":start,"finish":finish,
                     "duration":task["duration"],"effort":task["effort"],"resource":resource,
                     "blocking_predecessors":sorted(task["pred"]),
                     "blocking_resource":resource if start>release+1e-10 else None,
                     "active_days":task.get("active_days"),"fixed_observation_days":task.get("fixed_observation_days")}
        for pool,slot in zip(pools,slots):
            occupied=task["duration"]+(task.get("reservation_tail",0.0) if pool==task.get("station_type") else 0.0)
            calendars[pool][slot].append((start,start+occupied,key))
            if pool==task.get("station_type"):
                commissioned=max(result[k]["finish"] for k in station_setup_by_slot[pool,slot])
                result[key]["station_reservation"]={"resource":f"{pool}-{slot+1}","start":start,"finish":start+occupied,
                                                   "commissioned_at":commissioned}
        remaining.remove(key)

    # Dependency-only path ignores resource contention and all release dates.
    cp_memo={}
    def cp(k):
        if k not in cp_memo:
            cp_memo[k]=tasks[k]["duration"]+max((cp(x) for x in tasks[k]["pred"]),default=0.0)
        return cp_memo[k]
    for key in tasks:cp(key)
    ticket_summary={}
    for tid, ph in phases.items():
        host_day=result[ph["host_milestone"]]["finish"]
        target_day=result[ph["complete"]]["finish"] if "target_validation" in ph else None
        ticket_summary[tid]={"source_id":TICKET_SOURCE_IDS[tid],"host_accepted_day":host_day,
                             "target_complete_day":target_day,"complete_day":target_day if target_day is not None else host_day}
    makespan=max(r["finish"] for r in result.values())
    product_e=0.0
    raw_ticket_p=sum(float(r[3]) for r in rows.values())
    for row in rows.values():
        target_work=float(row[6])>0
        host_share=.50 if target_work else .75
        product_e += float(row[2])*(.25*human_mul+host_share*human_mul+
                                     (.25*max(1.0,human_mul) if target_work else 0.0))
    product_p=raw_ticket_p*principal_mul
    setup_e=float(setup["main_environment"]["engineer_days"])*human_mul
    setup_e+=sum(counts.values())*float(setup["per_target_station"]["engineer_days"])*human_mul
    setup_p=float(setup["main_environment"]["principal_days"])*human_mul
    setup_p+=sum(counts.values())*float(setup["per_target_station"]["principal_days"])*human_mul
    coord_e=reserve_e*makespan; coord_p=reserve_p*makespan
    operator_effort=sum(float(v) for v in operator_days.values())
    agent_effort=sum(r["effort"] for k,r in result.items() if "agent" in tasks[k]["pool"])
    physical_slot_days=sum(end-start for pool,slots in calendars.items() if pool in valid_station_types
                           for intervals in slots for start,end,_ in intervals)
    total_e=product_e+setup_e+coord_e
    total_p=product_p+setup_p+coord_p
    return {"scenario_inputs":p,"assigned_engineer_fte":assigned_e,"effective_engineer_phase_fte":e_fte,
      "assigned_principal_fte":assigned_p,"effective_principal_phase_fte":p_fte,"operator_fte":op_fte,
      "coordination_engineer_days":coord_e,"coordination_principal_days":coord_p,
      "product_engineer_days":product_e,"product_principal_days":product_p,
      "setup_engineer_days":setup_e,"setup_principal_days":setup_p,
      "operator_effort_days":operator_effort,"combined_engineer_days":total_e,"combined_principal_days":total_p,
      "agent_slot_days":agent_effort,"target_slot_days":physical_slot_days,
      "makespan_workdays":makespan,"makespan_weeks":makespan/5,
      "dependency_only_critical_path_workdays":max(cp_memo.values()),
      "schedule":sorted(result.values(),key=lambda x:(x["start"],x["resource"],x["ticket"],x["phase"])),
      "ticket_summary":ticket_summary,"_raw":{"tasks":tasks,"result":result,"phases":phases,
       "graph":graph,"capacities":capacities,"calendars":calendars,"cp":cp_memo,
       "station_types":station_types,"fixed_physical_durations":{
           "system_soak_workdays":float(assumptions["fixed_physical_duration_allowances"]["system_soak_workdays"]),
           "dry_out_observation_workdays":float(assumptions["fixed_physical_duration_allowances"]["dry_out_observation_workdays"])}}}


def package_result(name, model):
    baseline_total=BASELINE_E+BASELINE_P
    total=model["combined_engineer_days"]+model["combined_principal_days"]
    schedule=model["schedule"]
    setup_records=[r for r in schedule if r["ticket"].startswith(("dev_board-","prototype-","production_fixture-"))]
    milestones={"main_setup_complete":model["_raw"]["result"]["setup:host_ready"]["finish"],
      "target_commissioning_complete":max((r["finish"] for r in setup_records),default=0.0),
      "all_setup_activities_complete":model["_raw"]["result"]["setup:all_complete"]["finish"],
      "first_host_acceptance":min(x["host_accepted_day"] for x in model["ticket_summary"].values()),
      "last_host_acceptance":max(x["host_accepted_day"] for x in model["ticket_summary"].values()),
      "first_target_complete":min(x["target_complete_day"] for x in model["ticket_summary"].values() if x["target_complete_day"] is not None),
      "integration_target":model["ticket_summary"]["integration"]["target_complete_day"],
      "system_test_including_soak":model["ticket_summary"]["system-test"]["target_complete_day"],
      "dryout_including_observation":model["ticket_summary"]["dry-out"]["target_complete_day"],
      "sized_scope_complete":model["makespan_workdays"]}
    totals={"engineer_days":model["combined_engineer_days"],"principal_days":model["combined_principal_days"],
      "product_engineer_days":model["product_engineer_days"],"product_principal_days":model["product_principal_days"],
      "setup_engineer_days":model["setup_engineer_days"],"setup_principal_days":model["setup_principal_days"],
      "coordination_engineer_days":model["coordination_engineer_days"],"coordination_principal_days":model["coordination_principal_days"],
      "operator_days":model["operator_effort_days"],"agent_slot_days":model["agent_slot_days"],
      "target_slot_days":model["target_slot_days"]}
    return {"scenario":name,"inputs":model["scenario_inputs"],"totals":totals,
      "assigned_engineer_fte":model["assigned_engineer_fte"],"effective_engineer_phase_fte":model["effective_engineer_phase_fte"],
      "assigned_principal_fte":model["assigned_principal_fte"],"effective_principal_phase_fte":model["effective_principal_phase_fte"],
      "operator_fte":model["operator_fte"],"makespan_workdays":model["makespan_workdays"],
      "makespan_weeks":model["makespan_weeks"],
      "product_engineer_days_saved":BASELINE_E-model["product_engineer_days"],
      "engineer_days_saved":BASELINE_E-model["combined_engineer_days"],
      "engineer_saving_percent":100*(BASELINE_E-model["combined_engineer_days"])/BASELINE_E,
      "principal_days_saved":BASELINE_P-model["combined_principal_days"],
      "combined_role_days_saved":baseline_total-total,
      "elapsed_reduction_percent":100*(BASELINE_WEEKS-model["makespan_weeks"])/BASELINE_WEEKS,
      "milestones":milestones,"ticket_summary":model["ticket_summary"],
      "dependency_only_critical_path_workdays":model["dependency_only_critical_path_workdays"],
      "dependency_only_critical_path_note":"Dependency-only estimate, excludes resource contention and availability waits; the resource-constrained finish is not an optimality proof.",
      "resource_bottlenecks":{k:{"slots":v[0],"fte_per_slot":v[1],
        "occupied_effort_days":sum(x["effort"] for x in schedule
          if any(part==k or part.startswith(k+"-") for part in x["resource"].split("+"))),
        "occupied_calendar_workdays":sum(x["duration"] for x in schedule
          if any(part==k or part.startswith(k+"-") for part in x["resource"].split("+")))}
        for k,v in model["_raw"]["capacities"].items()},
      "schedule":model["schedule"]}


def validate(models, source_by_id, excluded, estimates, assumptions):
    check(len(TICKET_SOURCE_IDS)==30 and len(source_by_id)==33 and len(excluded)==3,"Source coverage must be 30 sized plus 3 unsized")
    displayed=sum(source_days(source_by_id[sid]) for sid in TICKET_SOURCE_IDS.values())
    check(round(displayed,1)==101.5,"Displayed source ticket sum must remain 101.5")
    check(float(assumptions["baseline_engineer_days"])==BASELINE_E,"Authoritative Engineer baseline must remain 101.4")
    check(float(assumptions["baseline_principal_days"])==BASELINE_P,"Principal baseline must remain separate at 15.2")
    if "target" in assumptions["scenarios"]:
        check(float(assumptions["physical_resources"]["operator_fte"])==.25,
              "Base operator capacity must remain 0.25 FTE")
    check(len(estimates["rows"])==30,"Expected 30 target estimate rows")
    for name, model in models.items():
        raw=model["_raw"]; result=raw["result"]; tasks=raw["tasks"]
        check(len([k for k in result if tasks[k]["kind"]=="ticket"])>=30*5,
              f"Missing ticket phases in {name}")
        for tid,ph in raw["phases"].items():
            check(result[ph["review"]]["start"]+1e-9>=result[ph["production"]]["finish"],
                  f"Independent review starts before implementation: {name}/{tid}")
            check(result[ph["principal_review"]]["start"]+1e-9>=result[ph["review"]]["finish"],
                  f"Human merge review starts before independent review: {name}/{tid}")
        for key,rec in result.items():
            for pred in tasks[key]["pred"]:
                check(rec["start"]+1e-9>=result[pred]["finish"],f"Precedence failure {name}: {key} before {pred}")
        for resource, intervals in raw["calendars"].items():
            for slot, entries in enumerate(intervals):
                entries=sorted(entries)
                for before, after in zip(entries,entries[1:]):
                    check(before[1]<=after[0]+1e-9,f"Resource overlap {name}: {resource}-{slot+1}")
        for tid, ph in raw["phases"].items():
            if "target_validation" not in ph: continue
            target=tasks[ph["target_validation"]]
            target_record=result[ph["target_validation"]]
            operator_record=result[ph["operator_validation"]]
            reservation=operator_record["station_reservation"]
            check(abs(target_record["start"]-operator_record["finish"])<1e-8,
                  f"Prepared target not held continuously: {name}/{tid}")
            check(target_record["resource"]==reservation["resource"] and
                  abs(target_record["finish"]-reservation["finish"])<1e-8,
                  f"Target run does not use its reserved station and interval: {name}/{tid}")
            check(reservation["start"]+1e-9>=reservation["commissioned_at"],
                  f"Target used before its own slot was commissioned: {name}/{tid}")
            check(model["ticket_summary"][tid]["target_complete_day"] is not None,
                  f"Missing target acceptance {name}/{tid}")
            check(abs(target["active_days"]-float(next(r[6] for r in estimates["rows"] if r[0]==tid)))<1e-9,
                  f"Physical active duration changed for {name}/{tid}")
            if tid=="system-test":
                check(target["fixed_observation_days"]==raw["fixed_physical_durations"]["system_soak_workdays"],
                      "System soak duration changed")
            if tid=="dry-out":
                check(target["fixed_observation_days"]==raw["fixed_physical_durations"]["dry_out_observation_workdays"],
                      "Dry-out observation duration changed")
            check(any(pred.startswith("setup:") for pred in tasks[ph["target_validation"]]["pred"]),
                  f"Target validation missing station commissioning gate: {name}/{tid}")
        scheduled_ticket_e=sum(rec["effort"] for key,rec in result.items()
                               if tasks[key]["kind"]=="ticket" and tasks[key]["pool"]==("engineer",))
        scheduled_ticket_p=sum(rec["effort"] for key,rec in result.items()
                               if tasks[key]["kind"]=="ticket" and tasks[key]["pool"]==("principal",))
        check(abs(scheduled_ticket_e-model["product_engineer_days"])<1e-8,
              f"Ticket Engineer effort does not sum in {name}")
        check(abs(scheduled_ticket_p-model["product_principal_days"])<1e-8,
              f"Ticket Principal effort does not sum in {name}")
        scheduled_setup_e=sum(rec["effort"] for key,rec in result.items()
                              if tasks[key]["kind"]=="setup" and tasks[key]["pool"]==("engineer",))
        scheduled_setup_p=sum(rec["effort"] for key,rec in result.items()
                              if tasks[key]["kind"]=="setup" and tasks[key]["pool"]==("principal",))
        check(abs(scheduled_setup_e-model["setup_engineer_days"])<1e-8,
              f"Setup Engineer effort does not sum in {name}")
        check(abs(scheduled_setup_p-model["setup_principal_days"])<1e-8,
              f"Setup Principal effort does not sum in {name}")
        integ=raw["result"][raw["phases"]["integration"]["complete"]]["finish"]
        for tid in ("sensor-drivers","actuator-drivers","ota","pressure","vpd","irrigation","low-media",
                    "zone-config","swap","recipes","lighting","disconnect","resume","api","pairing",
                    "alarms","events","self-test","dry-out"):
            check(integ>=model["ticket_summary"][tid]["target_complete_day"],f"Integration target gate missing {tid}")
        check(model["ticket_summary"]["system-test"]["target_complete_day"]>=
              model["ticket_summary"]["integration"]["target_complete_day"],"System test precedes integration target")
        check(model["makespan_workdays"]==max(x["finish"] for x in model["schedule"]),
              "Sized-scope milestone omits setup or ticket work")


def build_report(scenarios, sensitivities, contingency, assumptions, estimates, source_by_id, excluded):
    lines=["# Fleet estimate and deterministic schedule","",
      "Planning estimate only. No estimate or capacity represents measured performance. Day values are working-day offsets from each scenario start, not calendar dates. One week is five workdays.",
      "System soak allowance is 5 workdays and dry-out observation is 2 workdays. These are unconfirmed physical allowances, not source requirements or permission to shorten a test. Extended offline logging and ordered replay are included in the system-soak procedure.","",
      "The 30 source cards display 101.5 Engineer days. The authoritative schedule baseline is 101.4 Engineer days. Preserve this 0.1-day discrepancy without normalization. Principal baseline is separately 15.2 days.",
      "The source's 21.5-week duration is a draft comparator with different staffing assumptions, not an observed equal-capacity control.","",
      "## Scenario inputs","",
      "| Scenario | Agent slots | Dev boards | Engineer assigned/effective FTE | Principal assigned/effective FTE | Execution / human multiplier |",
      "|---|---:|---:|---:|---:|---:|"]
    for name,s in scenarios.items():
        p=s["inputs"]
        lines.append(f"| {name} | {p['agent_slots']} | {p['target_slots']} | {s['assigned_engineer_fte']:.2f}/{s['effective_engineer_phase_fte']:.2f} | {s['assigned_principal_fte']:.2f}/{s['effective_principal_phase_fte']:.2f} | {p['execution_multiplier']:.2f} / {p['human_multiplier']:.2f} |")
    lines += ["","All scenarios additionally use one prototype/plant station, one production fixture and independently available operator capacity of 0.25 FTE. Physical readiness is held constant.","",
      "## Scenario results","",
      "| Scenario | Engineer days, all-in | Principal days, all-in | Operator days | Working days | Weeks | Engineer days saved | Indicative elapsed reduction |",
      "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for name,s in scenarios.items():
        t=s["totals"]
        lines.append(f"| {name} | {t['engineer_days']:.2f} | {t['principal_days']:.2f} | {t['operator_days']:.2f} | {s['makespan_workdays']:.2f} | {s['makespan_weeks']:.2f} | {s['engineer_days_saved']:.2f} | {s['elapsed_reduction_percent']:.1f}% |")
    lines += ["","### Effort accounting","",
      "| Scenario | Product E / P | Setup E / P | Coordination E / P | Agent slot-days | Physical slot-days |",
      "|---|---:|---:|---:|---:|---:|"]
    for name,s in scenarios.items():
        t=s["totals"]
        lines.append(f"| {name} | {t['product_engineer_days']:.2f} / {t['product_principal_days']:.2f} | {t['setup_engineer_days']:.2f} / {t['setup_principal_days']:.2f} | {t['coordination_engineer_days']:.2f} / {t['coordination_principal_days']:.2f} | {t['agent_slot_days']:.2f} | {t['target_slot_days']:.2f} |")
    lines += ["","Savings use 101.4 Engineer and 15.2 Principal baseline role totals, with product, setup and coordination effort in the new estimate. Operator effort is additional and has no recovered baseline, so it has no claimed saving. The 21.5-week source schedule uses different staffing assumptions and is not an equal-capacity measured comparator.","",
      "Principal ticket estimates apply the explicit 1.5 human-review multiplier; the stretch scenario does not reduce this below the base policy. Engineer and Principal phase calendars use assigned FTE minus coordination reserves. Coordination effort is reserved FTE multiplied by elapsed workdays, including waits. Operator effort uses its separate 0.25 FTE pool.","",
      "## Per-ticket source and target estimate","",
      "| Target row | Source ID | Source Engineer days | Target Engineer days | Target Principal days at 1.5 policy | Agent production days | Independent agent review days | Target active days | Operator days | Station | Rationale category |","|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|"]
    categories={"scheduler":"foundation","host-simulation":"host harness","sensor-drivers":"drivers","actuator-drivers":"drivers","storage":"foundation","misc-io":"drivers","bringup":"hardware bring-up","ota":"firmware update","pressure":"control","vpd":"control","irrigation":"control","low-media":"control","zone-config":"configuration","swap":"lifecycle","recipes":"lifecycle","lighting":"control","recipe-store":"storage","disconnect":"safety/lifecycle","resume":"safety/lifecycle","identity":"identity","alarms":"fault handling","events":"offline data","api":"interface","pairing":"security","self-test":"physical acceptance","provisioning":"production acceptance","integration":"integration","system-test":"system verification","dry-out":"physical observation","release-records":"records"}
    stations=estimates["station_type_by_model_id"]; operators=estimates["operator_days_by_model_id"]
    for r in estimates["rows"]:
        tid=r[0]; sid=TICKET_SOURCE_IDS[tid]
        lines.append(f"| {r[1]} (`{tid}`) | `{sid}` | {source_days(source_by_id[sid]):.1f} | {r[2]:.2f} | {r[3]*assumptions['human_review_policy']['principal_review_estimate_multiplier']:.2f} | {r[4]:.2f} | {r[5]:.2f} | {r[6]:.2f} | {operators.get(tid,0):.2f} | {stations.get(tid,'host')} | {categories[tid]} |")
    lines += ["","Ticket Engineer effort is split into 25% briefing, 50% host acceptance and 25% target acceptance when target work exists; otherwise 25% briefing and 75% host acceptance. Principal review gates host acceptance. Target active work has a 1.0 multiplier floor; fixed observations and operator durations are not scenario-scaled. Principal target-ticket effort applies the human-review policy multiplier.","",
      "## Setup and physical resources","",
      f"Setup aggregate: Engineer {assumptions['setup_target_estimates']['main_environment']['engineer_days']:.2f}, Principal {assumptions['setup_target_estimates']['main_environment']['principal_days']:.2f}, agent {assumptions['setup_target_estimates']['main_environment']['agent_execution_days']:.2f} days, before scenario multipliers. Every dev-board, prototype and production-fixture station is commissioned after matching hardware readiness, with per-station estimates E {assumptions['setup_target_estimates']['per_target_station']['engineer_days']:.2f}, P {assumptions['setup_target_estimates']['per_target_station']['principal_days']:.2f}, agent {assumptions['setup_target_estimates']['per_target_station']['agent_execution_days']:.2f} days.",
      f"One prototype pool ({assumptions['physical_resources']['prototype_slots']} slot, ready day {assumptions['physical_resources']['prototype_ready_workday']}) is shared by control, integration, soak and dry-out. One production fixture (ready day {assumptions['physical_resources']['production_fixture_ready_workday']}) supports provisioning. Dev-board stations are ready day {assumptions['physical_resources']['dev_board_ready_workday']}; their count varies by scenario. Operator capacity is {assumptions['physical_resources']['operator_fte']:.2f} FTE. Setup effort is separate from product effort.",""]
    lines += ["","| Setup activity | Gate | Engineer days | Principal days | Agent days |",
              "|---|---|---:|---:|---:|"]
    for activity in assumptions["setup_target_estimates"]["activities"]:
        lines.append(f"| {activity['id']} | {activity['gate']} | {activity['engineer_days']:.2f} | {activity['principal_days']:.2f} | {activity['agent_execution_days']:.2f} |")
    lines += ["","## Milestones","","| Scenario | Main setup | First host acceptance | Last host acceptance | First target complete | Integration target | System test incl. soak | Dry-out incl. observation | Sized scope complete |","|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for name,s in scenarios.items():
        m=s["milestones"]
        lines.append(f"| {name} | {m['main_setup_complete']:.2f} | {m['first_host_acceptance']:.2f} | {m['last_host_acceptance']:.2f} | {m['first_target_complete']:.2f} | {m['integration_target']:.2f} | {m['system_test_including_soak']:.2f} | {m['dryout_including_observation']:.2f} | {m['sized_scope_complete']:.2f} |")
    lines += ["","Sized scope means all 30 sized tickets and fleet setup. It is not full release.","","## Resource-limited ticket timeline","","| Scenario | Ticket | Host accepted | Target complete |","|---|---|---:|---:|"]
    for name,s in scenarios.items():
        for tid,t in sorted(s["ticket_summary"].items(),key=lambda kv:(kv[1]["complete_day"],kv[0])):
            target="not applicable" if t["target_complete_day"] is None else f"{t['target_complete_day']:.2f}"
            lines.append(f"| {name} | `{tid}` | {t['host_accepted_day']:.2f} | {target} |")
    lines += ["","### Target-scenario phase schedule","",
      "| Ticket/setup activity | Phase | Start day | Finish day | Resource |",
      "|---|---|---:|---:|---|"]
    for row in scenarios["target"]["schedule"]:
        lines.append(f"| {row['ticket']} | {row['phase']} | {row['start']:.2f} | {row['finish']:.2f} | {row['resource']} |")
    lines += ["","Each schedule record also includes blocking predecessors and resource wait in the JSON output.","",
      "### Dependency and resource bounds","",
      "| Scenario | Dependency-only path workdays | Resource-constrained makespan workdays | Resource bottlenecks |",
      "|---|---:|---:|---|"]
    for name,s in scenarios.items():
        bottlenecks=", ".join(f"{k}: {v['occupied_calendar_workdays']:.2f} occupied workdays/{v['slots']} slots" for k,v in s["resource_bottlenecks"].items())
        lines.append(f"| {name} | {s['dependency_only_critical_path_workdays']:.2f} | {s['makespan_workdays']:.2f} | {bottlenecks} |")
    lines += ["","## Sensitivities","","Each row changes one input from target. Hardware readiness offsets move dev-board, prototype and production-fixture dates together. Physical active and fixed observation durations are not reduced below base durations.","","| Sensitivity | Value | Engineer days total | Principal days total | Agent slot-days | Target slot-days | Workdays | Weeks |","|---|---:|---:|---:|---:|---:|---:|---:|"]
    for label,items in sensitivities.items():
        for item in items:
            s=item
            lines.append(f"| {label} | {item['value']} | {s['totals']['engineer_days']:.2f} | {s['totals']['principal_days']:.2f} | {s['totals']['agent_slot_days']:.2f} | {s['totals']['target_slot_days']:.2f} | {s['makespan_workdays']:.2f} | {s['makespan_weeks']:.2f} |")
    lines += ["","The baseline-review sensitivity sets sized-ticket Principal effort to 15.2 days before setup and coordination. No test-role saving is computed because the source lists Test Engineer at 0.5 FTE but does not provide a role effort total.","",
      f"Explicit 1.25 human and execution contingency stress result: Engineer {contingency['totals']['engineer_days']:.2f} days, Principal {contingency['totals']['principal_days']:.2f} days, makespan {contingency['makespan_workdays']:.2f} workdays ({contingency['makespan_weeks']:.2f} weeks). This is not a probability and does not alter the base scenario estimates.","",
      "## Exclusions, limitations and break-even","",]
    for row in excluded:
        lines.append(f"- `{row['source_id']}`: {row['title']}, unsized and excluded from estimates; source dependencies remain in the extracted input.")
    lines += ["","Full release is not represented. ERP link, phone UI and release verification are unsized and excluded. Break-even allowance = saved Engineer days × Engineer day rate + saved Principal days × Principal day rate - operator days × operator rate - incremental equipment/model/other operating costs. Setup and recurring coordination are already included in forecast role days; do not subtract them twice. No rates or quotes were available, so no currency estimate is stated.","","## Deterministic schedule method","","Earliest-feasible-start list scheduling dispatches ready work without reserving human capacity for distant work ahead of nearer ready jobs; longest remaining downstream duration and stable task ID break ties. Each Engineer and Principal is one fractional-FTE calendar. Agent production and independent review share the same N-slot pool in sequential phases. Each station type is its own physical pool; operator is a separate fractional-FTE resource. Physical reservations cover manual preparation and the immediately following run on the same slot, while operator capacity is held only for the manual prefix. Dry-out evidence precedes integrated prototype acceptance as an explicit early-risk-reduction policy; alarms, events and self-test target acceptance also gate integration. Blocking predecessors and resource waits are in the JSON records; the CSV lists phase timing and resource. The dependency-only path excludes resource contention and dates; this feasible schedule is not an optimality proof.","","The 21.5-week baseline has different staffing assumptions and is not an equal-capacity observed comparator. Test Engineer 0.5 FTE appears in source staffing, but test-role total effort is unknown, so no test-role savings are claimed."]
    lines += ["","For jobs with the same earliest feasible start, station commissioning takes priority before the downstream-duration tie-break, so added resources are made usable rather than left until the end. Initial contract-decision latency can overlap environment setup and gates product briefing, not every setup activity.",
              "Sensitivities also change the dispatch order. A shorter heuristic schedule under a tighter input is evidence that the schedule can be improved, not evidence that delaying decisions or reducing capacity is beneficial. Do not interpret such local reversals as causal savings."]
    return "\n".join(lines)


def main():
    source=read_json(SOURCE); estimates=read_json(ESTIMATES); assumptions=read_json(ASSUMPTIONS)
    source_by_id,excluded=get_source(source); graph,excluded_edges=make_graph(source_by_id)
    models={name:schedule_scenario(name,scenario,estimates,assumptions,source_by_id,graph)
            for name,scenario in assumptions["scenarios"].items()}
    validate(models,source_by_id,excluded,estimates,assumptions)
    scenarios={name:package_result(name,model) for name,model in models.items()}
    target=assumptions["scenarios"]["target"]
    sensitivity_cases={
      "hardware_ready_offset_workdays":[0,5,15,25],
      "agent_slots":[3,6,10],"engineer_fte":[.6,.8,1.0],
      "system_soak_workdays":[5,10],"operator_fte":[.125,.25,.5],
      "decision_latency_workdays":[2,10],"baseline_ticket_principal_days":[15.2,22.8]}
    sensitivities={}; sensitivity_models={}
    raw_principal=sum(float(row[3]) for row in estimates["rows"])
    for label,values in sensitivity_cases.items():
        sensitivities[label]=[]
        for value in values:
            if label=="hardware_ready_offset_workdays":
                physical=assumptions["physical_resources"]
                override={"physical_resources":{
                    "dev_board_ready_workday":float(physical["dev_board_ready_workday"])+value,
                    "prototype_ready_workday":float(physical["prototype_ready_workday"])+value,
                    "production_fixture_ready_workday":float(physical["production_fixture_ready_workday"])+value}}
                model=schedule_scenario("target",target,estimates,assumptions,source_by_id,graph,overrides=override)
            elif label=="system_soak_workdays":
                altered=json.loads(json.dumps(assumptions))
                altered["fixed_physical_duration_allowances"]["system_soak_workdays"]=value
                model=schedule_scenario("target",target,estimates,altered,source_by_id,graph)
            elif label=="operator_fte":
                model=schedule_scenario("target",target,estimates,assumptions,source_by_id,graph,
                    overrides={"physical_resources":{"operator_fte":value}})
            elif label=="baseline_ticket_principal_days":
                altered=json.loads(json.dumps(assumptions))
                altered["human_review_policy"]["principal_review_estimate_multiplier"]=float(value)/raw_principal
                model=schedule_scenario("target",target,estimates,altered,source_by_id,graph)
            else:
                override={label:value}
                model=schedule_scenario("target",target,estimates,assumptions,source_by_id,graph,overrides=override)
            sensitivity_models[f"{label}-{value}"]=model
            summary=package_result("target",model)
            del summary["schedule"], summary["ticket_summary"]
            sensitivities[label].append({"value":value,**summary})
    stress_model=schedule_scenario("target",target,estimates,assumptions,source_by_id,graph,contingency=1.25)
    stress=package_result("target_1_25_contingency",stress_model)
    del stress["schedule"], stress["ticket_summary"]
    validate({**sensitivity_models,"target_1_25_contingency":stress_model},
             source_by_id,excluded,estimates,assumptions)
    check(round(sum(source_days(source_by_id[s]) for s in TICKET_SOURCE_IDS.values()),1)==101.5,
          "Displayed source total must remain 101.5; do not normalize")
    check(float(assumptions["baseline_engineer_days"])==101.4 and float(assumptions["baseline_principal_days"])==15.2,
          "Authoritative baseline values changed")
    output={"schema_version":1,"status":"planning estimates, not measured performance",
      "source_provenance":source.get("provenance",{}),"source_displayed_engineer_days":101.5,
      "authoritative_baseline_engineer_days":BASELINE_E,"principal_baseline_days":BASELINE_P,
      "baseline_discrepancy":"30 displayed ticket cards total 101.5 Engineer days; authoritative schedule baseline remains 101.4. No normalization.",
      "baseline_report_elapsed_weeks":BASELINE_WEEKS,
      "baseline_elapsed_caveat":"Draft schedule has different staffing assumptions; not a measured equal-capacity comparator.",
      "scenarios":scenarios,"sensitivities":sensitivities,"target_contingency_1_25":stress,
      "source_dependencies":{sid:list(row.get("dependencies",[])) for sid,row in source_by_id.items()},
      "scope_exclusions":[{"source_id":r["source_id"],"title":r["title"],"dependencies":r.get("dependencies",[])}
                          for r in excluded],
      "excluded_source_dependencies":excluded_edges,
      "break_even_formula":"(101.4 - forecast Engineer days) * Engineer day rate + (15.2 - forecast Principal days) * Principal day rate - operator days * operator day rate - incremental equipment/model/other operating costs; setup and recurring coordination already included in forecast role days",
      "test_engineer_savings":"Not computed; source staffing lists 0.5 FTE Test Engineer but no test-role effort total is available.",
      "operator_savings":"Not computed; source has no recovered Operator effort baseline.",
      "assumption_inputs":assumptions,
      "assumptions":assumptions["unconfirmed_conditions"]}
    report=build_report(scenarios,sensitivities,stress,assumptions,estimates,source_by_id,excluded)
    with CSV_PATH.open("w",encoding="utf-8",newline="") as stream:
        writer=csv.DictWriter(stream,fieldnames=["scenario","ticket","phase","start","finish","resource"])
        writer.writeheader()
        for name,scenario in scenarios.items():
            for row in scenario["schedule"]:
                writer.writerow({"scenario":name,"ticket":row["ticket"],"phase":row["phase"],
                    "start":f"{row['start']:.6f}","finish":f"{row['finish']:.6f}","resource":row["resource"]})
    RESULTS.write_text(json.dumps(output,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    REPORT.write_text(report+"\n",encoding="utf-8")

if __name__=="__main__":
    main()
