# Fleet effort estimate and delivery schedule

Forecast for the 30 sized work packages plus fleet setup. ERP link, phone UI and release verification remain unsized and excluded. The estimates need calibration against project work.
Times are working-day offsets from the start of each scenario. One week is five working days. The test authority must confirm the five-day soak and two-day dry-out observation allowances. The soak procedure also covers extended offline logging and ordered replay.

The source ticket values sum to 101.5 Engineer days. The savings comparison uses the schedule total of 101.4 Engineer days and 15.2 Principal days, retaining the source's 0.1-day discrepancy.
The source's 21.5-week forecast uses different staffing assumptions. An equal-capacity comparison needs an agreed staffing and loading basis.

## Scenario inputs

| Scenario | Agent slots | Dev boards | Engineer assigned/effective FTE | Principal assigned/effective FTE | Execution / human multiplier |
|---|---:|---:|---:|---:|---:|
| cautious | 3 | 1 | 0.60/0.50 | 0.25/0.23 | 1.40 / 1.30 |
| target | 6 | 2 | 0.80/0.70 | 0.35/0.33 | 1.00 / 1.00 |
| stretch | 10 | 3 | 1.00/0.90 | 0.45/0.43 | 0.80 / 0.85 |

Every scenario includes one prototype/plant station, one production fixture and 0.25 FTE of operator capacity. Hardware readiness is the same across scenarios.

## Scenario results

| Scenario | Engineer days, total | Principal days, total | Operator days | Working days | Weeks | Engineer days saved | Indicative elapsed reduction |
|---|---:|---:|---:|---:|---:|---:|---:|
| cautious | 38.20 | 16.62 | 4.40 | 86.95 | 17.39 | 63.20 | 19.1% |
| target | 28.72 | 12.65 | 4.40 | 55.15 | 11.03 | 72.68 | 48.7% |
| stretch | 25.35 | 12.21 | 4.40 | 46.87 | 9.37 | 76.05 | 56.4% |

### Effort breakdown

| Scenario | Product E / P | Setup E / P | Coordination E / P | Agent slot-days | Physical slot-days |
|---|---:|---:|---:|---:|---:|
| cautious | 20.41 / 11.89 | 9.10 / 2.99 | 8.69 / 1.74 | 36.82 | 34.05 |
| target | 15.70 / 9.15 | 7.50 / 2.40 | 5.52 / 1.10 | 26.55 | 34.05 |
| stretch | 13.87 / 9.15 | 6.80 / 2.12 | 4.69 / 0.94 | 21.44 | 34.05 |

Savings compare total forecast effort with the 101.4 Engineer-day and 15.2 Principal-day baseline. Totals include product work, setup and coordination. Operator effort is additional; the source gives no operator total for a savings comparison.

Principal ticket estimates use the 1.5 human-review allowance in every scenario. Engineer and Principal task capacity excludes the coordination reserve. Coordination effort is charged over the delivery window, including waits. Operator capacity is a separate 0.25 FTE pool.

## Per-ticket source and target estimate

| Target row | Source ID | Source Engineer days | Target Engineer days | Target Principal days at 1.5 policy | Agent production days | Independent agent review days | Target active days | Operator days | Station | Rationale category |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| Scheduler (`scheduler`) | `tk-scheduler` | 1.4 | 0.40 | 0.22 | 0.40 | 0.10 | 0.00 | 0.00 | host | foundation |
| Host simulation (`host-simulation`) | `tk-host-sim` | 4.3 | 0.60 | 0.30 | 0.80 | 0.25 | 0.00 | 0.00 | host | host harness |
| Sensor drivers and validity (`sensor-drivers`) | `tk-drv-sensors` | 4.3 | 0.50 | 0.22 | 0.60 | 0.20 | 0.25 | 0.10 | dev_board | drivers |
| Actuator drivers (`actuator-drivers`) | `tk-drv-actuators` | 2.9 | 0.40 | 0.22 | 0.50 | 0.20 | 0.25 | 0.15 | dev_board | drivers |
| Storage (`storage`) | `tk-storage` | 1.4 | 0.25 | 0.15 | 0.40 | 0.15 | 0.10 | 0.05 | dev_board | foundation |
| Miscellaneous I/O (`misc-io`) | `tk-drv-misc` | 2.1 | 0.30 | 0.15 | 0.40 | 0.15 | 0.20 | 0.10 | dev_board | drivers |
| Board bring-up (`bringup`) | `tk-bringup` | 1.4 | 0.60 | 0.30 | 0.50 | 0.20 | 0.50 | 0.25 | dev_board | hardware bring-up |
| OTA and revert (`ota`) | `tk-ota` | 2.9 | 0.45 | 0.30 | 0.60 | 0.20 | 0.25 | 0.10 | dev_board | firmware update |
| Pressure loop (`pressure`) | `tk-pressure-loop` | 7.1 | 0.90 | 0.45 | 1.00 | 0.40 | 1.00 | 0.25 | prototype | control |
| VPD controller (`vpd`) | `tk-vpd` | 5.7 | 0.80 | 0.45 | 1.00 | 0.40 | 0.50 | 0.20 | prototype | control |
| Irrigation and air exchange (`irrigation`) | `tk-irrigation` | 4.3 | 0.65 | 0.30 | 0.70 | 0.30 | 0.50 | 0.15 | prototype | control |
| Low-media detector (`low-media`) | `tk-low-media` | 4.3 | 0.60 | 0.30 | 0.70 | 0.30 | 0.50 | 0.10 | prototype | control |
| Zone configuration (`zone-config`) | `tk-zone-config` | 1.4 | 0.25 | 0.15 | 0.35 | 0.10 | 0.10 | 0.05 | prototype | configuration |
| Swap mode (`swap`) | `tk-swap-mode` | 1.4 | 0.25 | 0.15 | 0.35 | 0.10 | 0.15 | 0.10 | prototype | lifecycle |
| Recipe engine (`recipes`) | `tk-recipe-engine` | 5.7 | 0.80 | 0.38 | 1.00 | 0.30 | 0.25 | 0.05 | prototype | lifecycle |
| Lighting (`lighting`) | `tk-lighting` | 2.9 | 0.40 | 0.22 | 0.50 | 0.20 | 0.25 | 0.10 | prototype | control |
| Recipe store, import and export (`recipe-store`) | `tk-recipe-store` | 2.9 | 0.40 | 0.22 | 0.50 | 0.20 | 0.00 | 0.00 | host | storage |
| Disconnect and safe state (`disconnect`) | `tk-disconnect` | 4.3 | 0.60 | 0.38 | 0.70 | 0.30 | 0.50 | 0.20 | prototype | safety/lifecycle |
| Resume (`resume`) | `tk-resume` | 2.9 | 0.50 | 0.30 | 0.60 | 0.25 | 0.50 | 0.15 | prototype | safety/lifecycle |
| Identity and registration (`identity`) | `tk-identity` | 2.9 | 0.40 | 0.22 | 0.50 | 0.20 | 0.15 | 0.05 | dev_board | identity |
| Alarms (`alarms`) | `tk-alarms` | 2.1 | 0.35 | 0.22 | 0.40 | 0.20 | 0.25 | 0.10 | prototype | fault handling |
| Event log and offline queue (`events`) | `tk-events` | 3.6 | 0.50 | 0.30 | 0.70 | 0.25 | 0.25 | 0.10 | prototype | offline data |
| REST API and ICD (`api`) | `tk-rest-api` | 4.3 | 0.60 | 0.38 | 0.80 | 0.30 | 0.10 | 0.05 | dev_board | interface |
| Pairing and security (`pairing`) | `tk-pairing` | 2.9 | 0.50 | 0.45 | 0.60 | 0.30 | 0.15 | 0.05 | dev_board | security |
| Commissioning self-test (`self-test`) | `tk-selftest` | 2.9 | 0.50 | 0.30 | 0.60 | 0.25 | 0.50 | 0.25 | prototype | physical acceptance |
| Provisioning and end-of-line (`provisioning`) | `tk-provisioning` | 2.1 | 0.40 | 0.22 | 0.50 | 0.20 | 0.50 | 0.20 | production_fixture | production acceptance |
| Prototype integration (`integration`) | `tk-integration` | 4.3 | 0.90 | 0.45 | 0.80 | 0.40 | 1.00 | 0.50 | prototype | integration |
| System test and soak (`system-test`) | `tk-system-test` | 7.1 | 0.90 | 0.60 | 0.50 | 0.40 | 0.50 | 0.50 | prototype | system verification |
| Dry-out confirmation (`dry-out`) | `tk-dryout` | 4.3 | 0.60 | 0.38 | 0.40 | 0.25 | 0.25 | 0.50 | prototype | physical observation |
| Release and design records (`release-records`) | `tk-release-notes` | 1.4 | 0.40 | 0.45 | 0.40 | 0.20 | 0.00 | 0.00 | host | records |

Engineer effort is split into 25% briefing, 50% host acceptance and 25% target acceptance where target work is required. Host-only tickets use 25% briefing and 75% host acceptance. Principal review precedes host acceptance. Active physical tests, fixed observation periods and operator work retain their base durations across scenarios.

## Setup and physical resources

Shared setup allows 5.50 Engineer, 2.00 Principal and 0.50 agent days before scenario adjustments. Commissioning each board, prototype or production-fixture station adds 0.50 Engineer, 0.10 Principal and 0.25 agent days after its hardware is ready.
Control, integration, soak and dry-out share one prototype pool (1 slot, ready day 10). Provisioning uses a production fixture ready at day 10. Development boards are ready at day 5; their number varies by scenario. Operator capacity is 0.25 FTE. Setup and product effort are counted separately.


| Setup activity | Gate | Engineer days | Principal days | Agent days |
|---|---|---:|---:|---:|
| main-config | host | 2.00 | 0.50 | 0.50 |
| governance | host | 1.00 | 0.50 | 0.00 |
| security | host | 0.50 | 0.25 | 0.00 |
| durable-records | host | 1.00 | 0.25 | 0.00 |
| exclusive-access | target | 0.50 | 0.25 | 0.00 |
| forecast-analysis | after-first-wave | 0.50 | 0.25 | 0.00 |

## Milestones

| Scenario | Main setup | First host acceptance | Last host acceptance | First target complete | Integration target | System test incl. soak | Dry-out incl. observation | Sized scope complete |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cautious | 14.38 | 20.47 | 86.95 | 24.56 | 68.03 | 82.53 | 57.21 | 86.95 |
| target | 7.90 | 11.95 | 55.15 | 17.66 | 41.11 | 52.62 | 28.71 | 55.15 |
| stretch | 5.25 | 7.45 | 46.87 | 11.78 | 34.46 | 44.96 | 21.91 | 46.87 |

## Ticket schedule with resource limits

| Scenario | Ticket | Host accepted | Target complete |
|---|---|---:|---:|
| cautious | `scheduler` | 20.47 | not applicable |
| cautious | `bringup` | 22.58 | 24.56 |
| cautious | `storage` | 23.29 | 24.72 |
| cautious | `host-simulation` | 25.89 | not applicable |
| cautious | `sensor-drivers` | 27.06 | 30.93 |
| cautious | `actuator-drivers` | 29.14 | 31.19 |
| cautious | `vpd` | 33.53 | 36.32 |
| cautious | `recipes` | 35.54 | 36.84 |
| cautious | `recipe-store` | 38.73 | not applicable |
| cautious | `events` | 30.60 | 39.05 |
| cautious | `disconnect` | 37.62 | 39.44 |
| cautious | `identity` | 39.96 | 40.61 |
| cautious | `misc-io` | 27.97 | 40.81 |
| cautious | `pressure` | 42.79 | 45.37 |
| cautious | `api` | 46.21 | 47.25 |
| cautious | `resume` | 43.96 | 49.33 |
| cautious | `irrigation` | 48.10 | 49.76 |
| cautious | `lighting` | 49.01 | 51.06 |
| cautious | `alarms` | 50.21 | 51.28 |
| cautious | `dry-out` | 52.57 | 57.21 |
| cautious | `pairing` | 56.68 | 57.54 |
| cautious | `self-test` | 54.14 | 58.83 |
| cautious | `low-media` | 58.51 | 59.80 |
| cautious | `ota` | 62.55 | 63.49 |
| cautious | `swap` | 63.14 | 64.15 |
| cautious | `zone-config` | 63.99 | 64.45 |
| cautious | `integration` | 61.44 | 68.03 |
| cautious | `provisioning` | 65.45 | 68.88 |
| cautious | `system-test` | 74.44 | 82.53 |
| cautious | `release-records` | 86.95 | not applicable |
| target | `scheduler` | 11.95 | not applicable |
| target | `host-simulation` | 14.98 | not applicable |
| target | `bringup` | 13.11 | 17.66 |
| target | `recipe-store` | 18.22 | not applicable |
| target | `events` | 17.45 | 18.40 |
| target | `sensor-drivers` | 15.63 | 18.57 |
| target | `actuator-drivers` | 16.77 | 18.72 |
| target | `vpd` | 20.00 | 22.04 |
| target | `recipes` | 21.52 | 22.32 |
| target | `identity` | 20.29 | 23.07 |
| target | `misc-io` | 16.13 | 23.18 |
| target | `storage` | 13.61 | 23.27 |
| target | `disconnect` | 22.75 | 24.27 |
| target | `api` | 24.77 | 26.65 |
| target | `dry-out` | 23.70 | 28.71 |
| target | `pressure` | 26.35 | 30.62 |
| target | `self-test` | 30.15 | 31.98 |
| target | `pairing` | 32.48 | 33.01 |
| target | `irrigation` | 27.12 | 33.56 |
| target | `resume` | 27.88 | 34.18 |
| target | `ota` | 33.33 | 34.34 |
| target | `low-media` | 31.13 | 35.38 |
| target | `lighting` | 28.49 | 35.70 |
| target | `alarms` | 29.14 | 36.34 |
| target | `swap` | 35.16 | 36.84 |
| target | `zone-config` | 35.56 | 37.79 |
| target | `provisioning` | 36.22 | 38.05 |
| target | `integration` | 34.98 | 41.11 |
| target | `system-test` | 44.80 | 52.62 |
| target | `release-records` | 55.15 | not applicable |
| stretch | `scheduler` | 7.45 | not applicable |
| stretch | `host-simulation` | 9.68 | not applicable |
| stretch | `bringup` | 8.05 | 11.78 |
| stretch | `recipe-store` | 12.06 | not applicable |
| stretch | `sensor-drivers` | 10.10 | 12.92 |
| stretch | `events` | 12.30 | 13.39 |
| stretch | `actuator-drivers` | 12.49 | 14.71 |
| stretch | `identity` | 13.11 | 15.29 |
| stretch | `misc-io` | 11.38 | 15.37 |
| stretch | `storage` | 8.67 | 15.44 |
| stretch | `vpd` | 14.24 | 15.77 |
| stretch | `recipes` | 15.09 | 16.39 |
| stretch | `disconnect` | 16.05 | 18.01 |
| stretch | `api` | 17.61 | 19.82 |
| stretch | `dry-out` | 16.73 | 21.91 |
| stretch | `pressure` | 18.79 | 23.85 |
| stretch | `pairing` | 23.49 | 23.99 |
| stretch | `self-test` | 21.75 | 25.68 |
| stretch | `ota` | 24.20 | 25.80 |
| stretch | `irrigation` | 19.37 | 26.47 |
| stretch | `resume` | 20.05 | 27.53 |
| stretch | `provisioning` | 27.29 | 28.70 |
| stretch | `low-media` | 22.49 | 29.16 |
| stretch | `lighting` | 20.48 | 29.75 |
| stretch | `alarms` | 20.98 | 30.39 |
| stretch | `swap` | 25.54 | 30.91 |
| stretch | `zone-config` | 25.92 | 31.21 |
| stretch | `integration` | 25.42 | 34.46 |
| stretch | `system-test` | 37.21 | 44.96 |
| stretch | `release-records` | 46.87 | not applicable |

### Target-scenario phase schedule

| Ticket/setup activity | Phase | Start day | Finish day | Resource |
|---|---|---:|---:|---|
| setup | main-config_engineer | 0.00 | 2.86 | engineer |
| setup | main-config_agent | 2.86 | 3.36 | agent-1 |
| setup | governance_engineer | 2.86 | 4.29 | engineer |
| setup | main-config_principal | 3.36 | 4.87 | principal |
| setup | durable-records_engineer | 4.29 | 5.71 | engineer |
| setup | main-config_complete | 4.87 | 4.87 | gate |
| setup | governance_principal | 4.87 | 6.39 | principal |
| setup | security_engineer | 5.71 | 6.43 | engineer |
| setup | governance_complete | 6.39 | 6.39 | gate |
| setup | durable-records_principal | 6.39 | 7.15 | principal |
| setup | exclusive-access_engineer | 6.43 | 7.14 | engineer |
| setup | durable-records_complete | 7.15 | 7.15 | gate |
| setup | security_principal | 7.15 | 7.90 | principal |
| scheduler | briefing | 7.90 | 8.05 | engineer |
| setup | host_ready | 7.90 | 7.90 | gate |
| setup | security_complete | 7.90 | 7.90 | gate |
| setup | exclusive-access_principal | 7.90 | 8.66 | principal |
| scheduler | production | 8.05 | 8.45 | agent-1 |
| bringup | briefing | 8.05 | 8.26 | engineer |
| bringup | production | 8.26 | 8.76 | agent-2 |
| scheduler | review | 8.45 | 8.55 | agent-1 |
| dev_board-1 | station_commissioning_engineer | 8.66 | 9.37 | engineer |
| setup | exclusive-access_complete | 8.66 | 8.66 | gate |
| scheduler | principal_review | 8.66 | 9.34 | principal |
| bringup | review | 8.76 | 8.96 | agent-1 |
| bringup | principal_review | 9.34 | 10.25 | principal |
| dev_board-1 | station_commissioning_agent | 9.37 | 9.62 | agent-1 |
| dev_board-2 | station_commissioning_engineer | 9.37 | 10.09 | engineer |
| dev_board-2 | station_commissioning_agent | 10.09 | 10.34 | agent-1 |
| prototype-1 | station_commissioning_engineer | 10.09 | 10.80 | engineer |
| dev_board-1 | station_commissioning_principal | 10.25 | 10.55 | principal |
| dev_board-2 | station_commissioning_principal | 10.55 | 10.86 | principal |
| prototype-1 | station_commissioning_agent | 10.80 | 11.05 | agent-1 |
| production_fixture-1 | station_commissioning_engineer | 10.80 | 11.52 | engineer |
| prototype-1 | station_commissioning_principal | 10.86 | 11.16 | principal |
| production_fixture-1 | station_commissioning_agent | 11.52 | 11.77 | agent-1 |
| scheduler | host_acceptance | 11.52 | 11.95 | engineer |
| production_fixture-1 | station_commissioning_principal | 11.52 | 11.82 | principal |
| host-simulation | briefing | 11.95 | 12.16 | engineer |
| host-simulation | production | 12.16 | 12.96 | agent-1 |
| sensor-drivers | briefing | 12.16 | 12.34 | engineer |
| sensor-drivers | production | 12.34 | 12.94 | agent-2 |
| storage | briefing | 12.34 | 12.43 | engineer |
| storage | production | 12.43 | 12.83 | agent-3 |
| misc-io | briefing | 12.43 | 12.54 | engineer |
| misc-io | production | 12.54 | 12.94 | agent-4 |
| actuator-drivers | briefing | 12.54 | 12.68 | engineer |
| actuator-drivers | production | 12.68 | 13.18 | agent-5 |
| bringup | host_acceptance | 12.68 | 13.11 | engineer |
| storage | review | 12.83 | 12.98 | agent-3 |
| misc-io | review | 12.94 | 13.09 | agent-4 |
| sensor-drivers | review | 12.94 | 13.14 | agent-2 |
| host-simulation | review | 12.96 | 13.21 | agent-1 |
| storage | principal_review | 12.98 | 13.43 | principal |
| bringup | operator_validation | 13.11 | 14.11 | dev_board-1+operator |
| actuator-drivers | review | 13.18 | 13.38 | agent-2 |
| storage | host_acceptance | 13.43 | 13.61 | engineer |
| host-simulation | principal_review | 13.43 | 14.34 | principal |
| events | briefing | 13.61 | 13.79 | engineer |
| events | production | 13.79 | 14.49 | agent-1 |
| recipe-store | briefing | 13.79 | 13.93 | engineer |
| recipe-store | production | 13.93 | 14.43 | agent-2 |
| ota | briefing | 13.93 | 14.09 | engineer |
| ota | production | 14.09 | 14.69 | agent-3 |
| bringup | target_validation | 14.11 | 14.61 | dev_board-1 |
| storage | operator_validation | 14.11 | 14.31 | dev_board-2+operator |
| storage | target_validation | 14.31 | 14.41 | dev_board-2 |
| host-simulation | host_acceptance | 14.34 | 14.98 | engineer |
| sensor-drivers | principal_review | 14.34 | 15.02 | principal |
| recipe-store | review | 14.43 | 14.63 | agent-2 |
| events | review | 14.49 | 14.74 | agent-1 |
| ota | review | 14.69 | 14.89 | agent-2 |
| recipes | briefing | 14.98 | 15.27 | engineer |
| misc-io | principal_review | 15.02 | 15.48 | principal |
| recipes | production | 15.27 | 16.27 | agent-1 |
| sensor-drivers | host_acceptance | 15.27 | 15.63 | engineer |
| actuator-drivers | principal_review | 15.48 | 16.16 | principal |
| sensor-drivers | operator_validation | 15.63 | 16.03 | dev_board-1+operator |
| vpd | briefing | 15.63 | 15.91 | engineer |
| vpd | production | 15.91 | 16.91 | agent-2 |
| misc-io | host_acceptance | 15.91 | 16.13 | engineer |
| sensor-drivers | target_validation | 16.03 | 16.28 | dev_board-1 |
| misc-io | operator_validation | 16.13 | 16.53 | dev_board-2+operator |
| identity | briefing | 16.13 | 16.27 | engineer |
| events | principal_review | 16.16 | 17.07 | principal |
| recipes | review | 16.27 | 16.57 | agent-1 |
| identity | production | 16.27 | 16.77 | agent-3 |
| disconnect | briefing | 16.27 | 16.48 | engineer |
| disconnect | production | 16.48 | 17.18 | agent-4 |
| actuator-drivers | host_acceptance | 16.48 | 16.77 | engineer |
| misc-io | target_validation | 16.53 | 16.73 | dev_board-2 |
| identity | review | 16.77 | 16.97 | agent-1 |
| actuator-drivers | operator_validation | 16.77 | 17.37 | dev_board-1+operator |
| pressure | briefing | 16.77 | 17.09 | engineer |
| vpd | review | 16.91 | 17.31 | agent-2 |
| recipe-store | principal_review | 17.07 | 17.75 | principal |
| pressure | production | 17.09 | 18.09 | agent-1 |
| events | host_acceptance | 17.09 | 17.45 | engineer |
| disconnect | review | 17.18 | 17.48 | agent-3 |
| actuator-drivers | target_validation | 17.37 | 17.62 | dev_board-1 |
| bringup | engineer_target_acceptance | 17.45 | 17.66 | engineer |
| events | operator_validation | 17.45 | 17.85 | prototype-1+operator |
| alarms | briefing | 17.66 | 17.79 | engineer |
| bringup | target_acceptance | 17.66 | 17.66 | gate |
| vpd | principal_review | 17.75 | 19.11 | principal |
| alarms | production | 17.79 | 18.19 | agent-2 |
| recipe-store | host_acceptance | 17.79 | 18.22 | engineer |
| events | target_validation | 17.85 | 18.10 | prototype-1 |
| pressure | review | 18.09 | 18.49 | agent-1 |
| alarms | review | 18.19 | 18.39 | agent-2 |
| events | engineer_target_acceptance | 18.22 | 18.40 | engineer |
| sensor-drivers | engineer_target_acceptance | 18.40 | 18.57 | engineer |
| events | target_acceptance | 18.40 | 18.40 | gate |
| actuator-drivers | engineer_target_acceptance | 18.57 | 18.72 | engineer |
| sensor-drivers | target_acceptance | 18.57 | 18.57 | gate |
| setup | forecast-analysis_engineer | 18.72 | 19.43 | engineer |
| actuator-drivers | target_acceptance | 18.72 | 18.72 | gate |
| identity | principal_review | 19.11 | 19.80 | principal |
| vpd | host_acceptance | 19.43 | 20.00 | engineer |
| recipes | principal_review | 19.80 | 20.93 | principal |
| identity | host_acceptance | 20.00 | 20.29 | engineer |
| vpd | operator_validation | 20.00 | 20.80 | prototype-1+operator |
| dry-out | briefing | 20.29 | 20.50 | engineer |
| dry-out | production | 20.50 | 20.90 | agent-1 |
| api | briefing | 20.50 | 20.72 | engineer |
| api | production | 20.72 | 21.52 | agent-2 |
| irrigation | briefing | 20.72 | 20.95 | engineer |
| identity | operator_validation | 20.80 | 21.00 | dev_board-1+operator |
| vpd | target_validation | 20.80 | 21.30 | prototype-1 |
| dry-out | review | 20.90 | 21.15 | agent-1 |
| disconnect | principal_review | 20.93 | 22.07 | principal |
| irrigation | production | 20.95 | 21.65 | agent-3 |
| recipes | host_acceptance | 20.95 | 21.52 | engineer |
| identity | target_validation | 21.00 | 21.15 | dev_board-1 |
| api | review | 21.52 | 21.82 | agent-1 |
| lighting | briefing | 21.52 | 21.66 | engineer |
| recipes | operator_validation | 21.52 | 21.72 | prototype-1+operator |
| irrigation | review | 21.65 | 21.95 | agent-2 |
| lighting | production | 21.66 | 22.16 | agent-3 |
| zone-config | briefing | 21.66 | 21.75 | engineer |
| recipes | target_validation | 21.72 | 21.97 | prototype-1 |
| zone-config | production | 21.75 | 22.10 | agent-4 |
| vpd | engineer_target_acceptance | 21.75 | 22.04 | engineer |
| recipes | engineer_target_acceptance | 22.04 | 22.32 | engineer |
| vpd | target_acceptance | 22.04 | 22.04 | gate |
| dry-out | principal_review | 22.07 | 23.21 | principal |
| zone-config | review | 22.10 | 22.20 | agent-1 |
| lighting | review | 22.16 | 22.36 | agent-2 |
| disconnect | host_acceptance | 22.32 | 22.75 | engineer |
| recipes | target_acceptance | 22.32 | 22.32 | gate |
| resume | briefing | 22.75 | 22.93 | engineer |
| disconnect | operator_validation | 22.75 | 23.55 | prototype-1+operator |
| resume | production | 22.93 | 23.53 | agent-1 |
| identity | engineer_target_acceptance | 22.93 | 23.07 | engineer |
| misc-io | engineer_target_acceptance | 23.07 | 23.18 | engineer |
| identity | target_acceptance | 23.07 | 23.07 | gate |
| storage | engineer_target_acceptance | 23.18 | 23.27 | engineer |
| misc-io | target_acceptance | 23.18 | 23.18 | gate |
| api | principal_review | 23.21 | 24.34 | principal |
| dry-out | host_acceptance | 23.27 | 23.70 | engineer |
| storage | target_acceptance | 23.27 | 23.27 | gate |
| resume | review | 23.53 | 23.78 | agent-1 |
| disconnect | target_validation | 23.55 | 24.05 | prototype-1 |
| disconnect | engineer_target_acceptance | 24.05 | 24.27 | engineer |
| dry-out | operator_validation | 24.05 | 26.05 | prototype-1+operator |
| disconnect | target_acceptance | 24.27 | 24.27 | gate |
| api | host_acceptance | 24.34 | 24.77 | engineer |
| pressure | principal_review | 24.34 | 25.71 | principal |
| self-test | briefing | 24.77 | 24.95 | engineer |
| self-test | production | 24.95 | 25.55 | agent-1 |
| pairing | briefing | 24.95 | 25.13 | engineer |
| pairing | production | 25.13 | 25.73 | agent-2 |
| self-test | review | 25.55 | 25.80 | agent-1 |
| pressure | host_acceptance | 25.71 | 26.35 | engineer |
| irrigation | principal_review | 25.71 | 26.61 | principal |
| pairing | review | 25.73 | 26.03 | agent-2 |
| api | operator_validation | 26.05 | 26.25 | dev_board-1+operator |
| dry-out | target_validation | 26.05 | 28.30 | prototype-1 |
| api | target_validation | 26.25 | 26.35 | dev_board-1 |
| swap | briefing | 26.35 | 26.44 | engineer |
| swap | production | 26.44 | 26.79 | agent-1 |
| api | engineer_target_acceptance | 26.44 | 26.65 | engineer |
| resume | principal_review | 26.61 | 27.52 | principal |
| irrigation | host_acceptance | 26.65 | 27.12 | engineer |
| api | target_acceptance | 26.65 | 26.65 | gate |
| swap | review | 26.79 | 26.89 | agent-1 |
| low-media | briefing | 27.12 | 27.33 | engineer |
| low-media | production | 27.33 | 28.03 | agent-1 |
| resume | host_acceptance | 27.52 | 27.88 | engineer |
| lighting | principal_review | 27.52 | 28.21 | principal |
| low-media | review | 28.03 | 28.33 | agent-1 |
| lighting | host_acceptance | 28.21 | 28.49 | engineer |
| alarms | principal_review | 28.21 | 28.89 | principal |
| pressure | operator_validation | 28.30 | 29.30 | prototype-1+operator |
| dry-out | engineer_target_acceptance | 28.49 | 28.71 | engineer |
| dry-out | target_acceptance | 28.71 | 28.71 | gate |
| alarms | host_acceptance | 28.89 | 29.14 | engineer |
| self-test | principal_review | 28.89 | 29.80 | principal |
| integration | briefing | 29.14 | 29.46 | engineer |
| pressure | target_validation | 29.30 | 30.30 | prototype-1 |
| integration | production | 29.46 | 30.26 | agent-1 |
| self-test | host_acceptance | 29.80 | 30.15 | engineer |
| low-media | principal_review | 29.80 | 30.71 | principal |
| integration | review | 30.26 | 30.66 | agent-1 |
| pressure | engineer_target_acceptance | 30.30 | 30.62 | engineer |
| self-test | operator_validation | 30.30 | 31.30 | prototype-1+operator |
| pressure | target_acceptance | 30.62 | 30.62 | gate |
| low-media | host_acceptance | 30.71 | 31.13 | engineer |
| pairing | principal_review | 30.71 | 32.07 | principal |
| self-test | target_validation | 31.30 | 31.80 | prototype-1 |
| self-test | engineer_target_acceptance | 31.80 | 31.98 | engineer |
| irrigation | operator_validation | 31.80 | 32.40 | prototype-1+operator |
| provisioning | briefing | 31.98 | 32.12 | engineer |
| self-test | target_acceptance | 31.98 | 31.98 | gate |
| ota | principal_review | 32.07 | 32.98 | principal |
| provisioning | production | 32.12 | 32.62 | agent-1 |
| pairing | host_acceptance | 32.12 | 32.48 | engineer |
| irrigation | target_validation | 32.40 | 32.90 | prototype-1 |
| pairing | operator_validation | 32.48 | 32.68 | dev_board-1+operator |
| provisioning | review | 32.62 | 32.82 | agent-1 |
| pairing | target_validation | 32.68 | 32.83 | dev_board-1 |
| pairing | engineer_target_acceptance | 32.83 | 33.01 | engineer |
| resume | operator_validation | 32.90 | 33.50 | prototype-1+operator |
| integration | principal_review | 32.98 | 34.34 | principal |
| ota | host_acceptance | 33.01 | 33.33 | engineer |
| pairing | target_acceptance | 33.01 | 33.01 | gate |
| irrigation | engineer_target_acceptance | 33.33 | 33.56 | engineer |
| ota | operator_validation | 33.50 | 33.90 | dev_board-1+operator |
| resume | target_validation | 33.50 | 34.00 | prototype-1 |
| irrigation | target_acceptance | 33.56 | 33.56 | gate |
| ota | target_validation | 33.90 | 34.15 | dev_board-1 |
| resume | engineer_target_acceptance | 34.00 | 34.18 | engineer |
| low-media | operator_validation | 34.00 | 34.40 | prototype-1+operator |
| ota | engineer_target_acceptance | 34.18 | 34.34 | engineer |
| resume | target_acceptance | 34.18 | 34.18 | gate |
| ota | target_acceptance | 34.34 | 34.34 | gate |
| integration | host_acceptance | 34.34 | 34.98 | engineer |
| swap | principal_review | 34.34 | 34.80 | principal |
| low-media | target_validation | 34.40 | 34.90 | prototype-1 |
| zone-config | principal_review | 34.80 | 35.25 | principal |
| lighting | operator_validation | 34.90 | 35.30 | prototype-1+operator |
| swap | host_acceptance | 34.98 | 35.16 | engineer |
| low-media | engineer_target_acceptance | 35.16 | 35.38 | engineer |
| provisioning | principal_review | 35.25 | 35.93 | principal |
| lighting | target_validation | 35.30 | 35.55 | prototype-1 |
| zone-config | host_acceptance | 35.38 | 35.56 | engineer |
| low-media | target_acceptance | 35.38 | 35.38 | gate |
| alarms | operator_validation | 35.55 | 35.95 | prototype-1+operator |
| lighting | engineer_target_acceptance | 35.56 | 35.70 | engineer |
| lighting | target_acceptance | 35.70 | 35.70 | gate |
| provisioning | host_acceptance | 35.93 | 36.22 | engineer |
| setup | forecast-analysis_principal | 35.93 | 36.69 | principal |
| alarms | target_validation | 35.95 | 36.20 | prototype-1 |
| swap | operator_validation | 36.20 | 36.60 | prototype-1+operator |
| alarms | engineer_target_acceptance | 36.22 | 36.34 | engineer |
| alarms | target_acceptance | 36.34 | 36.34 | gate |
| provisioning | operator_validation | 36.60 | 37.40 | production_fixture-1+operator |
| swap | target_validation | 36.60 | 36.75 | prototype-1 |
| setup | all_complete | 36.69 | 36.69 | gate |
| setup | forecast-analysis_complete | 36.69 | 36.69 | gate |
| swap | engineer_target_acceptance | 36.75 | 36.84 | engineer |
| swap | target_acceptance | 36.84 | 36.84 | gate |
| provisioning | target_validation | 37.40 | 37.90 | production_fixture-1 |
| zone-config | operator_validation | 37.40 | 37.60 | prototype-1+operator |
| zone-config | target_validation | 37.60 | 37.70 | prototype-1 |
| zone-config | engineer_target_acceptance | 37.70 | 37.79 | engineer |
| zone-config | target_acceptance | 37.79 | 37.79 | gate |
| integration | operator_validation | 37.79 | 39.79 | prototype-1+operator |
| provisioning | engineer_target_acceptance | 37.90 | 38.05 | engineer |
| provisioning | target_acceptance | 38.05 | 38.05 | gate |
| integration | target_validation | 39.79 | 40.79 | prototype-1 |
| integration | engineer_target_acceptance | 40.79 | 41.11 | engineer |
| system-test | briefing | 41.11 | 41.43 | engineer |
| integration | target_acceptance | 41.11 | 41.11 | gate |
| system-test | production | 41.43 | 41.93 | agent-1 |
| system-test | review | 41.93 | 42.33 | agent-1 |
| system-test | principal_review | 42.33 | 44.15 | principal |
| system-test | host_acceptance | 44.15 | 44.80 | engineer |
| system-test | operator_validation | 44.80 | 46.80 | prototype-1+operator |
| system-test | target_validation | 46.80 | 52.30 | prototype-1 |
| system-test | engineer_target_acceptance | 52.30 | 52.62 | engineer |
| release-records | briefing | 52.62 | 52.76 | engineer |
| system-test | target_acceptance | 52.62 | 52.62 | gate |
| release-records | production | 52.76 | 53.16 | agent-1 |
| release-records | review | 53.16 | 53.36 | agent-1 |
| release-records | principal_review | 53.36 | 54.72 | principal |
| release-records | host_acceptance | 54.72 | 55.15 | engineer |

The JSON records identify blocking predecessors and resource waits.

### Dependency and resource limits

| Scenario | Dependency-only path workdays | Resource-constrained makespan workdays | Resource bottlenecks |
|---|---:|---:|---|
| cautious | 54.95 | 86.95 | engineer: 59.02 occupied workdays/1 slots, principal: 64.72 occupied workdays/1 slots, agent: 36.82 occupied workdays/3 slots, operator: 17.60 occupied workdays/1 slots, dev_board: 5.55 occupied workdays/1 slots, prototype: 27.20 occupied workdays/1 slots, production_fixture: 1.30 occupied workdays/1 slots |
| target | 37.32 | 55.15 | engineer: 33.14 occupied workdays/1 slots, principal: 35.00 occupied workdays/1 slots, agent: 26.55 occupied workdays/6 slots, operator: 17.60 occupied workdays/1 slots, dev_board: 5.55 occupied workdays/2 slots, prototype: 27.20 occupied workdays/1 slots, production_fixture: 1.30 occupied workdays/1 slots |
| stretch | 31.31 | 46.87 | engineer: 22.96 occupied workdays/1 slots, principal: 26.22 occupied workdays/1 slots, agent: 21.44 occupied workdays/10 slots, operator: 17.60 occupied workdays/1 slots, dev_board: 5.55 occupied workdays/3 slots, prototype: 27.20 occupied workdays/1 slots, production_fixture: 1.30 occupied workdays/1 slots |

## Sensitivities

Each case changes one target assumption. A hardware offset moves all three resource-readiness dates together. Active physical tests keep their base durations; the soak sensitivity extends observation from five to ten working days.

| Sensitivity | Value | Engineer days total | Principal days total | Agent slot-days | Target slot-days | Workdays | Weeks |
|---|---:|---:|---:|---:|---:|---:|---:|
| hardware_ready_offset_workdays | 0 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| hardware_ready_offset_workdays | 5 | 28.73 | 12.66 | 26.55 | 34.05 | 55.26 | 11.05 |
| hardware_ready_offset_workdays | 15 | 29.34 | 12.78 | 26.55 | 34.05 | 61.39 | 12.28 |
| hardware_ready_offset_workdays | 25 | 30.38 | 12.99 | 26.55 | 34.05 | 71.76 | 14.35 |
| agent_slots | 3 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| agent_slots | 6 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| agent_slots | 10 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| engineer_fte | 0.6 | 29.16 | 12.74 | 26.55 | 34.05 | 59.62 | 11.92 |
| engineer_fte | 0.8 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| engineer_fte | 1.0 | 28.44 | 12.60 | 26.55 | 34.05 | 52.45 | 10.49 |
| system_soak_workdays | 5 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| system_soak_workdays | 10 | 29.22 | 12.75 | 26.55 | 39.05 | 60.15 | 12.03 |
| operator_fte | 0.125 | 30.04 | 12.92 | 26.55 | 51.65 | 68.36 | 13.67 |
| operator_fte | 0.25 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| operator_fte | 0.5 | 28.31 | 12.57 | 26.55 | 25.25 | 51.14 | 10.23 |
| decision_latency_workdays | 2 | 28.72 | 12.65 | 26.55 | 34.05 | 55.15 | 11.03 |
| decision_latency_workdays | 10 | 28.85 | 12.68 | 26.55 | 34.05 | 56.48 | 11.30 |
| baseline_ticket_principal_days | 15.2 | 30.21 | 19.00 | 26.55 | 34.05 | 70.07 | 14.01 |
| baseline_ticket_principal_days | 22.8 | 32.40 | 27.04 | 26.55 | 34.05 | 92.01 | 18.40 |

The review sensitivity retains 15.2 Principal days for sized-ticket work, then adds setup and coordination. The source lists 0.5 FTE of Test Engineer capacity but gives no role effort total for a savings comparison.

With human and execution allowances at 1.25 times the base, the forecast is 35.39 Engineer days, 15.72 Principal days and 63.88 working days (12.78 weeks). This stress case is separate from the base scenarios and carries no probability estimate.

## Exclusions and cost basis

- `tk-erp-link`: Outbound ERP link with store-and-forward, unsized and excluded. Source dependencies are retained in the input.
- `tk-phone-ui`: Phone interface, unsized and excluded. Source dependencies are retained in the input.
- `tk-release-verification`: Release verification, unsized and excluded. Source dependencies are retained in the input.

The break-even allowance is saved Engineer days × Engineer rate + saved Principal days × Principal rate - operator days × operator rate - incremental equipment, model and other operating costs. Setup and coordination are already included in forecast role days. Rates and quotes are needed before calculating a currency saving.

## Scheduling method

The model assigns ready work at its earliest feasible start. At a common start time, station commissioning takes priority, followed by the longest remaining dependency chain and a stable task ID.
Engineer, Principal and operator work each have a fractional-FTE calendar. Implementation and independent agent review run in sequence through the same worker pool. Each hardware type has its own pool.
A target reservation covers manual preparation and the following run on the same commissioned station. The operator is occupied only during manual preparation. Integration waits for dry-out evidence, alarms, events and self-test target acceptance. Dry-out before integration is an added risk-reduction policy.
The initial decision allowance gates product briefing and can overlap environment setup. JSON records show predecessors and resource waits; the CSV gives phase times and resources.
The dependency-only path omits resource contention and readiness dates. The calculated schedule is feasible; optimality has not been established. A shorter schedule under a tighter input shows that dispatch order can improve. It provides no evidence that delays or reduced capacity save time.
