"""Private guest identities, retention and durable abuse budgets."""

import sqlalchemy as sa
from alembic import context, op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

IDENTITY = (
    "(is_guest AND email IS NULL AND password_hash IS NULL AND registered_at IS NULL "
    "AND guest_last_active_at IS NOT NULL AND guest_expires_at IS NOT NULL "
    "AND guest_expires_at > guest_last_active_at) OR "
    "(NOT is_guest AND email IS NOT NULL AND password_hash IS NOT NULL AND registered_at IS NOT NULL "
    "AND guest_last_active_at IS NULL AND guest_expires_at IS NULL)"
)


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("is_guest", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("guest_last_active_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("guest_expires_at", sa.DateTime(timezone=True)))
        batch.add_column(
            sa.Column("registered_at", sa.DateTime(timezone=True), server_default=sa.text("CURRENT_TIMESTAMP"))
        )
        batch.alter_column("email", existing_type=sa.String(254), nullable=True)
        batch.alter_column("password_hash", existing_type=sa.String(255), nullable=True)
        batch.create_check_constraint("ck_user_identity", IDENTITY)
        batch.create_index("ix_users_guest_expiry", ["is_guest", "guest_expires_at"])
    op.execute("UPDATE users SET registered_at = created_at WHERE NOT is_guest")
    op.add_column(
        "chat_runs", sa.Column("guest_budget_charged", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.create_table(
        "guest_counters",
        sa.Column("action", sa.String(32), primary_key=True),
        sa.Column("scope", sa.String(80), primary_key=True),
        sa.Column("window_start", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_guest_counters_expires_at", "guest_counters", ["expires_at"])


def downgrade() -> None:
    if context.is_offline_mode():
        raise RuntimeError("Guest downgrade requires an online safety check")
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT count(*) FROM users WHERE is_guest OR email IS NULL OR password_hash IS NULL")
    ):
        raise RuntimeError("Cannot downgrade while guest identities exist")
    if connection.scalar(sa.text("SELECT count(*) FROM chat_runs WHERE guest_budget_charged AND state = 'running'")):
        raise RuntimeError("Cannot downgrade while guest generations are running")
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("ck_user_identity", type_="check")
        batch.drop_index("ix_users_guest_expiry")
        batch.alter_column("email", existing_type=sa.String(254), nullable=False)
        batch.alter_column("password_hash", existing_type=sa.String(255), nullable=False)
        for column in ("registered_at", "guest_expires_at", "guest_last_active_at", "is_guest"):
            batch.drop_column(column)
    with op.batch_alter_table("chat_runs") as batch:
        batch.drop_column("guest_budget_charged")
    op.drop_table("guest_counters")
