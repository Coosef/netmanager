from celery import Celery
from app.core.config import settings

celery_app = Celery(
    "network_manager",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=[
        "app.workers.tasks.driver_tasks",
        "app.workers.tasks.backup_tasks",
        "app.workers.tasks.bulk_tasks",
        "app.workers.tasks.monitor_tasks",
        "app.workers.tasks.topology_tasks",
        "app.workers.tasks.playbook_tasks",
        "app.workers.tasks.notification_tasks",
        "app.workers.tasks.mac_arp_tasks",
        "app.workers.tasks.security_audit_tasks",
        "app.workers.tasks.lifecycle_tasks",
        "app.workers.tasks.snmp_tasks",
        "app.workers.tasks.rotation_tasks",
        "app.workers.tasks.rollout_tasks",
        "app.workers.tasks.behavior_analytics_tasks",
        "app.workers.tasks.retention_tasks",
        "app.workers.tasks.sla_tasks",
        "app.workers.tasks.availability_tasks",
        "app.workers.tasks.correlation_tasks",
        "app.workers.tasks.synthetic_tasks",
        "app.workers.tasks.agent_peer_tasks",
        "app.workers.tasks.escalation_tasks",
        "app.workers.tasks.metrics_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Europe/Istanbul",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    result_expires=86400,  # 24 hours
    beat_max_loop_interval=300,
    task_default_queue="default",
    # Faz 5E — Celery resilience
    task_soft_time_limit=1200,           # 20 min → SoftTimeLimitExceeded (task can clean up)
    task_time_limit=1500,                # 25 min → SIGKILL (hard ceiling)
    worker_max_memory_per_child=524288,  # 512 MB per worker (KB) → recycle on OOM
    broker_connection_retry_on_startup=True,
    broker_transport_options={
        "socket_timeout": 5,
        "socket_connect_timeout": 5,
        "retry_policy": {"timeout": 5.0},
    },
    task_routes={
        "app.workers.tasks.bulk_tasks.*": {"queue": "bulk"},
        "app.workers.tasks.monitor_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.topology_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.playbook_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.notification_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.mac_arp_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.security_audit_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.lifecycle_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.snmp_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.rotation_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.rollout_tasks.*": {"queue": "monitor"},
        "app.workers.tasks.behavior_analytics_tasks.*": {"queue": "monitor"},
        # Faz 6A — agent-dispatched tasks get their own isolated queue
        "app.workers.tasks.synthetic_tasks.*": {"queue": "agent_cmd"},
        "app.workers.tasks.agent_peer_tasks.*": {"queue": "agent_cmd"},
    },
    beat_schedule={
        "poll-device-status-every-5min": {
            "task": "app.workers.tasks.monitor_tasks.poll_device_status",
            "schedule": 300.0,
        },
        "confirm-stale-recovering-every-5min": {
            "task": "app.workers.tasks.correlation_tasks.confirm_stale_recovering",
            "schedule": 300.0,
        },
        "backup-configs-daily": {
            "task": "app.workers.tasks.bulk_tasks.scheduled_backup",
            "schedule": 86400.0,
        },
        "check-backup-schedules-every-minute": {
            "task": "app.workers.tasks.bulk_tasks.check_backup_schedules",
            "schedule": 60.0,
        },
        "topology-discovery-every-6h": {
            "task": "app.workers.tasks.topology_tasks.scheduled_topology_discovery",
            "schedule": 21600.0,
        },
        "run-scheduled-playbooks-every-minute": {
            "task": "app.workers.tasks.playbook_tasks.run_scheduled_playbooks",
            "schedule": 60.0,
        },
        "process-notifications-every-5min": {
            "task": "app.workers.tasks.notification_tasks.process_notifications",
            "schedule": 300.0,
        },
        "weekly-digest-monday-morning": {
            "task": "app.workers.tasks.notification_tasks.send_weekly_digest",
            "schedule": 604800.0,  # 7 days
        },
        "collect-mac-arp-every-15min": {
            "task": "app.workers.tasks.mac_arp_tasks.collect_mac_arp_all",
            "schedule": 900.0,
        },
        "cleanup-stale-tasks-every-30min": {
            "task": "app.workers.tasks.monitor_tasks.cleanup_stale_tasks",
            "schedule": 1800.0,
        },
        "poll-snmp-every-5min": {
            "task": "app.workers.tasks.snmp_tasks.poll_snmp_all",
            "schedule": 300.0,
        },
        "check-lifecycle-expirations-daily": {
            "task": "app.workers.tasks.lifecycle_tasks.check_lifecycle_expirations",
            "schedule": 86400.0,  # once per day
        },
        "weekly-compliance-scan-sunday": {
            "task": "app.workers.tasks.security_audit_tasks.scheduled_compliance_scan",
            "schedule": 604800.0,  # once per week
        },
        "check-rotation-policies-daily": {
            "task": "app.workers.tasks.rotation_tasks.check_rotation_policies",
            "schedule": 86400.0,  # once per day
        },
        "check-config-drift-daily": {
            "task": "app.workers.tasks.backup_tasks.check_config_drift",
            "schedule": 86400.0,  # once per day
        },
        # Sprint 14A — Behavior Analytics
        "update-baselines-daily": {
            "task": "app.workers.tasks.behavior_analytics_tasks.update_baselines",
            "schedule": 86400.0,  # once per day
        },
        "detect-anomalies-every-30min": {
            "task": "app.workers.tasks.behavior_analytics_tasks.detect_anomalies",
            "schedule": 1800.0,  # every 30 minutes
        },
        "check-topology-drift-every-6h": {
            "task": "app.workers.tasks.behavior_analytics_tasks.check_topology_drift",
            "schedule": 21600.0,  # every 6 hours
        },
        "data-retention-cleanup-daily": {
            "task": "app.workers.tasks.retention_tasks.cleanup_old_data",
            "schedule": 86400.0,  # once per day
        },
        "check-sla-breaches-daily": {
            "task": "app.workers.tasks.sla_tasks.check_sla_breaches",
            "schedule": 86400.0,  # once per day
        },
        "update-device-availability-scores-daily": {
            "task": "app.workers.tasks.availability_tasks.compute_availability_scores",
            "schedule": 86400.0,  # once per day
        },
        "run-synthetic-probes-every-minute": {
            "task": "app.workers.tasks.synthetic_tasks.run_synthetic_probes",
            "schedule": 60.0,
        },
        "measure-agent-peer-latency-every-15min": {
            "task": "app.workers.tasks.agent_peer_tasks.measure_agent_peer_latency",
            "schedule": 900.0,
        },
        "evaluate-escalation-rules-every-5min": {
            "task": "app.workers.tasks.escalation_tasks.evaluate_escalation_rules",
            "schedule": 300.0,
        },
        "collect-infrastructure-metrics-every-minute": {
            "task": "app.workers.tasks.metrics_tasks.collect_infrastructure_metrics",
            "schedule": 60.0,
        },
    },
)

import app.workers.signals  # noqa: E402,F401 — register Celery signal handlers
