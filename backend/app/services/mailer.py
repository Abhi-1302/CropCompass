"""Shared outgoing mail through Mailjet or a configured SMTP relay."""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage

from app.config import Settings

log = logging.getLogger(__name__)


def send_email(settings: Settings, to: str, subject: str, body: str) -> None:
    if settings.email_delivery != "email":
        if settings.email_delivery == "unavailable":
            log.error("Email not sent: configure MAILJET_API_KEY, MAILJET_API_SECRET and MAILJET_FROM, or SMTP_HOST")
        else:
            log.warning(
                "Email is not configured, so this email was not sent.\nTo: %s\nSubject: %s\n\n%s", to, subject, body
            )
        return
    if settings.mailjet_requested:
        host, port = settings.mailjet_host, settings.mailjet_port
        username, password = settings.mailjet_api_key, settings.mailjet_api_secret
        sender, starttls = settings.mailjet_from, True
    else:
        host, port = settings.smtp_host, settings.smtp_port
        username, password = settings.smtp_username, settings.smtp_password
        sender, starttls = settings.smtp_from, settings.smtp_starttls
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = sender, to, subject
    message.set_content(body)
    try:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            if starttls:
                smtp.starttls(context=ssl.create_default_context())
            if username:
                smtp.login(username, password or "")
            smtp.send_message(message)
    except (smtplib.SMTPException, OSError) as error:
        log.error("Could not send email to %s (%s)", to, type(error).__name__)
