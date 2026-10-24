"""password resets, field boundaries and farmer soil values

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-16 20:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0004'
down_revision: str | Sequence[str] | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql')


def upgrade() -> None:
    op.create_table('password_resets',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('password_resets', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_password_resets_token_hash'), ['token_hash'], unique=True)
        batch_op.create_index(batch_op.f('ix_password_resets_user_id'), ['user_id'], unique=False)

    with op.batch_alter_table('farms', schema=None) as batch_op:
        batch_op.add_column(sa.Column('boundary', JSON, nullable=True))
        batch_op.add_column(sa.Column('soil_override', JSON, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('farms', schema=None) as batch_op:
        batch_op.drop_column('soil_override')
        batch_op.drop_column('boundary')

    with op.batch_alter_table('password_resets', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_password_resets_user_id'))
        batch_op.drop_index(batch_op.f('ix_password_resets_token_hash'))

    op.drop_table('password_resets')
