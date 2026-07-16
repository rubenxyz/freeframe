"""add short_code column to share_links

Revision ID: 0001_add_short_code
Revises: f9a0b1c2d3e4
Create Date: 2026-07-16 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0001_add_short_code'
down_revision: Union[str, None] = 'f9a0b1c2d3e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'share_links',
        sa.Column('short_code', sa.String(10), nullable=True)
    )
    op.create_index(
        op.f('ix_share_links_short_code'),
        'share_links',
        ['short_code'],
        unique=True
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_share_links_short_code'), table_name='share_links')
    op.drop_column('share_links', 'short_code')
