"""Send notifications through configured channels (email, Slack, Telegram, Teams, webhook, Jira)."""
import base64
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

logger = logging.getLogger(__name__)


async def send_channel(channel, subject: str, body: str) -> tuple[bool, str | None]:
    """Dispatch to the right sender based on channel type. Returns (success, error)."""
    try:
        if channel.type == "slack":
            return await _send_slack(channel.config, subject, body)
        elif channel.type == "teams":
            return await _send_teams(channel.config, subject, body)
        elif channel.type == "webhook":
            return await _send_webhook(channel.config, subject, body)
        elif channel.type == "telegram":
            return await _send_telegram(channel.config, subject, body)
        elif channel.type == "email":
            return await _send_email(channel.config, subject, body)
        elif channel.type == "jira":
            return await _send_jira(channel.config, subject, body)
        else:
            return False, f"Unknown channel type: {channel.type}"
    except Exception as exc:
        logger.exception("Notification send failed for channel %s", channel.id)
        return False, str(exc)


async def _send_teams(config: dict, subject: str, body: str) -> tuple[bool, str | None]:
    webhook_url = config.get("webhook_url", "")
    if not webhook_url:
        return False, "webhook_url not configured"

    payload = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "themeColor": "0078D4",
        "summary": subject,
        "sections": [{"activityTitle": f"**{subject}**", "text": body}],
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(webhook_url, json=payload)
        if resp.status_code in (200, 202):
            return True, None
        return False, f"Teams returned {resp.status_code}: {resp.text}"


async def _send_webhook(config: dict, subject: str, body: str) -> tuple[bool, str | None]:
    url = config.get("url", "")
    if not url:
        return False, "url not configured"

    extra_headers = config.get("headers", {})
    payload = {"subject": subject, "body": body, "source": "NetManager"}

    headers = {"Content-Type": "application/json", **extra_headers}
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code < 300:
            return True, None
        return False, f"Webhook returned {resp.status_code}: {resp.text[:200]}"


async def _send_slack(config: dict, subject: str, body: str) -> tuple[bool, str | None]:
    webhook_url = config.get("webhook_url", "")
    if not webhook_url:
        return False, "webhook_url not configured"

    text = f"*{subject}*\n{body}"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(webhook_url, json={"text": text})
        if resp.status_code == 200:
            return True, None
        return False, f"Slack returned {resp.status_code}: {resp.text}"


async def _send_telegram(config: dict, subject: str, body: str) -> tuple[bool, str | None]:
    token = config.get("bot_token", "")
    chat_id = config.get("chat_id", "")
    if not token or not chat_id:
        return False, "bot_token or chat_id not configured"

    text = f"<b>{subject}</b>\n{body}"
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(url, json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"})
        data = resp.json()
        if data.get("ok"):
            return True, None
        return False, data.get("description", "Unknown Telegram error")


async def _send_email(config: dict, subject: str, body: str) -> tuple[bool, str | None]:
    smtp_host = config.get("smtp_host", "")
    smtp_port = int(config.get("smtp_port", 587))
    use_tls = bool(config.get("smtp_use_tls", True))
    username = config.get("smtp_username", "")
    password = config.get("smtp_password", "")
    recipients = config.get("recipients", [])

    if not smtp_host:
        return False, "smtp_host not configured"
    if not recipients:
        return False, "No recipients configured"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[NetManager] {subject}"
    msg["From"] = username or "noreply@netmanager.local"
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(body, "plain", "utf-8"))

    try:
        if use_tls:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
            server.starttls()
        else:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10)

        if username and password:
            server.login(username, password)
        server.sendmail(msg["From"], recipients, msg.as_string())
        server.quit()
        return True, None
    except Exception as exc:
        return False, str(exc)


async def _send_jira(config: dict, subject: str, body: str) -> tuple[bool, str | None]:
    """Create a Jira issue via Jira REST API v3 (Atlassian Cloud or Server).

    Required config keys:
      jira_url        — base URL, e.g. https://mycompany.atlassian.net
      jira_email      — Atlassian account email (for Cloud) or username (for Server)
      jira_api_token  — Atlassian API token (Cloud) or password (Server)
      jira_project_key — Jira project key, e.g. NET or OPS
    Optional:
      jira_issue_type — default "Bug"
      jira_priority   — override priority (Highest/High/Medium/Low/Lowest)
    """
    base_url = (config.get("jira_url") or "").rstrip("/")
    email = config.get("jira_email") or ""
    api_token = config.get("jira_api_token") or ""
    project_key = config.get("jira_project_key") or ""
    issue_type = config.get("jira_issue_type") or "Bug"
    priority_override = config.get("jira_priority") or None

    if not base_url:
        return False, "jira_url not configured"
    if not email or not api_token:
        return False, "jira_email and jira_api_token are required"
    if not project_key:
        return False, "jira_project_key not configured"

    # Basic auth: base64(email:token)
    credentials = base64.b64encode(f"{email}:{api_token}".encode()).decode()
    headers = {
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    # Map subject prefix to Jira priority
    priority_name = priority_override
    if not priority_name:
        subject_upper = subject.upper()
        if "[CRITICAL]" in subject_upper:
            priority_name = "Highest"
        elif "[WARNING]" in subject_upper or "[HIGH]" in subject_upper:
            priority_name = "High"
        else:
            priority_name = "Medium"

    # Jira Cloud uses Atlassian Document Format for description
    payload = {
        "fields": {
            "project": {"key": project_key},
            "summary": f"[NetManager] {subject}",
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": body}],
                    }
                ],
            },
            "issuetype": {"name": issue_type},
            "priority": {"name": priority_name},
        }
    }

    url = f"{base_url}/rest/api/3/issue"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code in (200, 201):
            data = resp.json()
            return True, None
        # Fallback: try plain-text description (Jira Server / older versions)
        if resp.status_code in (400, 422):
            payload["fields"]["description"] = body  # type: ignore[index]
            resp2 = await client.post(url, json=payload, headers=headers)
            if resp2.status_code in (200, 201):
                return True, None
            return False, f"Jira returned {resp2.status_code}: {resp2.text[:300]}"
        return False, f"Jira returned {resp.status_code}: {resp.text[:300]}"
