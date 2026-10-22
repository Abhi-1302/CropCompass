"""farm priorities and saved plans

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-16 18:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0003'
down_revision: str | Sequence[str] | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('plans',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('farm_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('title', sa.String(length=80), nullable=False),
    sa.Column('inputs', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('option', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('engine_version', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['farm_id'], ['farms.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('plans', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_plans_farm_id'), ['farm_id'], unique=False)

    with op.batch_alter_table('farms', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('priorities', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table('farms', schema=None) as batch_op:
        batch_op.drop_column('priorities')

    with op.batch_alter_table('plans', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_plans_farm_id'))

    op.drop_table('plans')
