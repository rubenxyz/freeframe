from pydantic import BaseModel, EmailStr, Field, field_validator
import uuid
from ..models.user import UserStatus

# Password constraints. bcrypt silently truncates at 72 bytes; surface
# that as a 400 instead of letting longer passwords authenticate against
# only their first 72 bytes. The 8-char floor closes the empty/1-char
# password hole that let accounts be created with trivially-guessable
# credentials.
_PASSWORD_FIELD = Field(min_length=8, max_length=72)

class RegisterRequest(BaseModel):
    email: EmailStr
    name: str
    password: str = _PASSWORD_FIELD

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = _PASSWORD_FIELD

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    needs_password: bool = False  # True if user needs to set password

class RefreshRequest(BaseModel):
    refresh_token: str

class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    avatar_url: str | None
    status: UserStatus
    email_verified: bool = False
    is_superadmin: bool = False
    preferences: dict = {}

    model_config = {"from_attributes": True}

    @field_validator("avatar_url", mode="after")
    @classmethod
    def resolve_avatar_url(cls, v: str | None) -> str | None:
        if v and not v.startswith("http"):
            from ..services import s3_service
            return s3_service.generate_presigned_get_url(v)
        return v


class AdminUserResponse(UserResponse):
    """Admin-scoped user view. Extends UserResponse with the invite token,
    which is a credential — it must never be exposed to non-admin callers
    (any-authenticated-user endpoints that returned UserResponse leaked
    invite tokens, enabling account takeover via /auth/accept-invite)."""
    invite_token: str | None = None

class InviteRequest(BaseModel):
    email: EmailStr
    name: str

# Magic code flow
class SendMagicCodeRequest(BaseModel):
    email: EmailStr

class SendMagicCodeResponse(BaseModel):
    message: str
    email: str

class VerifyMagicCodeRequest(BaseModel):
    email: EmailStr
    code: str

class SetPasswordRequest(BaseModel):
    password: str = _PASSWORD_FIELD

# Invite flow
class AcceptInviteRequest(BaseModel):
    token: str
    password: str = _PASSWORD_FIELD

class InviteInfoResponse(BaseModel):
    email: str
    name: str
    org_name: str | None = None

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UpdateProfileRequest(BaseModel):
    name: str | None = None
    avatar_url: str | None = None

class UpdateUserRoleRequest(BaseModel):
    is_admin: bool

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID


class PreferencesUpdate(BaseModel):
    """Schema-constrained preferences update.

    Replaces the previous `body: dict` signature on PATCH /auth/me/preferences
    so users can't store arbitrary giant/nested values (which would also be a
    stored-XSS surface if any preference is rendered back without escaping).
    Known keys only, primitive values only.
    """
    theme: str | None = None

