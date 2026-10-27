"""Persistent Sprout conversations, generation attempts and daily usage budgets."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table(
        "chat_threads",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("farm_id", sa.Uuid(), sa.ForeignKey("farms.id", ondelete="CASCADE")),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("language", sa.String(2), nullable=False),
        sa.Column("scenario", json_type, nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("summary_through", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    for column in ("user_id", "farm_id"):
        op.create_index(f"ix_chat_threads_{column}", "chat_threads", [column])
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("thread_id", sa.Uuid(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(12), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("evidence", json_type, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("thread_id", "sequence", name="uq_chat_message_sequence"),
        sa.CheckConstraint("role IN ('user', 'assistant')", name="ck_chat_message_role"),
    )
    op.create_index("ix_chat_messages_thread_id", "chat_messages", ["thread_id"])
    op.create_table(
        "chat_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("thread_id", sa.Uuid(), sa.ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_message_id", sa.Uuid(), sa.ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("reserved_tokens", sa.Integer(), nullable=False),
        sa.Column("usage_tokens", sa.Integer()),
        sa.Column("error_code", sa.String(32)),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("thread_id", "request_id", name="uq_chat_run_request"),
        sa.CheckConstraint(
            "state IN ('running', 'complete', 'failed', 'cancelled', 'interrupted')", name="ck_chat_run_state"
        ),
    )
    op.create_index("ix_chat_runs_thread_id", "chat_runs", ["thread_id"])
    op.create_index("ix_chat_runs_lease_expires_at", "chat_runs", ["lease_expires_at"])
    op.create_index(
        "uq_chat_running_thread", "chat_runs", ["thread_id"], unique=True,
        postgresql_where=sa.text("state = 'running'"), sqlite_where=sa.text("state = 'running'"),
    )
    op.create_table(
        "chat_usage_daily",
        sa.Column("scope", sa.String(48), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("requests", sa.Integer(), nullable=False),
        sa.Column("tokens", sa.Integer(), nullable=False),
    )
    op.create_index("ix_chat_usage_daily_user_id", "chat_usage_daily", ["user_id"])


def downgrade() -> None:
    for table in ("chat_usage_daily", "chat_runs", "chat_messages", "chat_threads"):
        op.drop_table(table)
