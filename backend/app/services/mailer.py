"""Outgoing email over SMTP. Without SMTP settings in local development, messages are written to the server log."""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from app.config import Settings

log = logging.getLogger(__name__)


def send_email(settings: Settings, to: str, subject: str, body: str) -> None:
    if not settings.smtp_host:
        if settings.cookie_secure:  # a deployed server: never put links with secrets in its logs
            log.error("Email to %s not sent: SMTP_HOST is not configured", to)
        else:
            log.warning(
                "SMTP_HOST is not set, so this email was not sent.\nTo: %s\nSubject: %s\n\n%s", to, subject, body
            )
        return
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = settings.smtp_from, to, subject
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
            if settings.smtp_starttls:
                smtp.starttls()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password or "")
            smtp.send_message(message)
    except (smtplib.SMTPException, OSError):
        log.exception("Could not send email to %s", to)
