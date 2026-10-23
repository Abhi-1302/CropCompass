import smtplib
import ssl
from unittest.mock import MagicMock

import pytest

from app.services.mailer import send_email


@pytest.fixture
def smtp_transport(monkeypatch):
    factory = MagicMock()
    monkeypatch.setattr("app.services.mailer.smtplib.SMTP", factory)
    return factory, factory.return_value.__enter__.return_value


@pytest.fixture
def mailjet_settings(settings):
    settings.mailjet_api_key = "test-mailjet-key"
    settings.mailjet_api_secret = "test-mailjet-secret"
    settings.mailjet_from = "AuraFarming <sender@example.com>"
    settings.mailjet_host = "in.mailjet.com"
    settings.mailjet_port = 2525
    return settings


@pytest.mark.parametrize("custom_endpoint", [False, True])
def test_mailjet_uses_tls_before_login_and_sends_message(mailjet_settings, smtp_transport, custom_endpoint):
    factory, smtp = smtp_transport
    mailjet_settings.smtp_host = "unused.example.com"
    mailjet_settings.smtp_starttls = False
    if custom_endpoint:
        mailjet_settings.mailjet_host = "in-v3.mailjet.com"
        mailjet_settings.mailjet_port = 587
    send_email(mailjet_settings, "recipient@example.com", "Reset your password", "Your reset link")
    factory.assert_called_once_with(mailjet_settings.mailjet_host, mailjet_settings.mailjet_port, timeout=20)
    assert [call[0] for call in smtp.method_calls] == ["starttls", "login", "send_message"]
    context = smtp.starttls.call_args.kwargs["context"]
    assert isinstance(context, ssl.SSLContext)
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    smtp.login.assert_called_once_with("test-mailjet-key", "test-mailjet-secret")
    message = smtp.send_message.call_args.args[0]
    assert str(message["From"]) == "AuraFarming <sender@example.com>"
    assert str(message["To"]) == "recipient@example.com"
    assert str(message["Subject"]) == "Reset your password"
    assert message.get_content().strip() == "Your reset link"


@pytest.mark.parametrize("missing", ["mailjet_api_key", "mailjet_api_secret", "mailjet_from"])
def test_incomplete_mailjet_never_connects_or_logs_body(mailjet_settings, smtp_transport, caplog, missing):
    factory, _ = smtp_transport
    mailjet_settings.smtp_host = "unused.example.com"
    setattr(mailjet_settings, missing, None)
    send_email(mailjet_settings, "recipient@example.com", "Reset", "private-reset-token")
    factory.assert_not_called()
    assert "Email not sent" in caplog.text
    assert "private-reset-token" not in caplog.text
    assert "test-mailjet-key" not in caplog.text
    assert "test-mailjet-secret" not in caplog.text


@pytest.mark.parametrize("cookie_secure", [False, True])
def test_unconfigured_mail_only_logs_links_in_development(settings, smtp_transport, caplog, cookie_secure):
    factory, _ = smtp_transport
    settings.cookie_secure = cookie_secure
    send_email(settings, "recipient@example.com", "Reset", "private-reset-token")
    factory.assert_not_called()
    assert ("private-reset-token" in caplog.text) is not cookie_secure


@pytest.mark.parametrize("starttls", [False, True])
def test_existing_smtp_configuration_still_works(settings, smtp_transport, starttls):
    factory, smtp = smtp_transport
    settings.smtp_host = "smtp.example.com"
    settings.smtp_port = 587
    settings.smtp_username = "smtp-user"
    settings.smtp_password = "smtp-password"
    settings.smtp_from = "AuraFarming <smtp@example.com>"
    settings.smtp_starttls = starttls
    send_email(settings, "recipient@example.com", "Reset", "Your reset link")
    factory.assert_called_once_with("smtp.example.com", 587, timeout=20)
    assert smtp.starttls.call_count == int(starttls)
    smtp.login.assert_called_once_with("smtp-user", "smtp-password")
    assert str(smtp.send_message.call_args.args[0]["From"]) == "AuraFarming <smtp@example.com>"


@pytest.mark.parametrize("stage", ["connect", "starttls", "login", "send_message"])
def test_mail_failures_do_not_leak_secrets(mailjet_settings, smtp_transport, caplog, stage):
    factory, smtp = smtp_transport
    sensitive = "test-mailjet-key test-mailjet-secret private-reset-token"
    if stage == "connect":
        factory.side_effect = OSError(sensitive)
    elif stage == "starttls":
        smtp.starttls.side_effect = smtplib.SMTPNotSupportedError(sensitive)
    elif stage == "login":
        smtp.login.side_effect = smtplib.SMTPAuthenticationError(535, sensitive.encode())
    else:
        smtp.send_message.side_effect = smtplib.SMTPException(sensitive)
    send_email(mailjet_settings, "recipient@example.com", "Reset", "private-reset-token")
    assert "Could not send email" in caplog.text
    assert all(value not in caplog.text for value in sensitive.split())
    if stage in {"connect", "starttls"}:
        smtp.login.assert_not_called()
    if stage != "send_message":
        smtp.send_message.assert_not_called()
