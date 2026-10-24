"""Versioned weather verification and resumable annual checkpoints."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("climate_cells") as batch:
        batch.add_column(sa.Column("quality", sa.String(20), nullable=False, server_default="unverified"))
        batch.add_column(sa.Column("quality_error", sa.Text(), nullable=True))
        batch.add_column(sa.Column("revision", sa.String(36), nullable=True))
        batch.add_column(sa.Column("validation_version", sa.String(40), nullable=True))
        batch.add_column(sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("years_done", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("years_total", sa.Integer(), nullable=False, server_default="0"))
    op.create_table(
        "weather_years",
        sa.Column("cell_id", sa.String(32), sa.ForeignKey("climate_cells.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("year", sa.Integer(), primary_key=True),
        sa.Column("series", sa.LargeBinary(), nullable=False),
        sa.Column("provenance", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=False),
        sa.Column("validation_version", sa.String(40), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("weather_years")
    with op.batch_alter_table("climate_cells") as batch:
        for name in (
            "years_total",
            "years_done",
            "validated_at",
            "validation_version",
            "revision",
            "quality_error",
            "quality",
        ):
            batch.drop_column(name)
