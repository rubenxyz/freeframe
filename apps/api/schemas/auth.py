from pydantic import BaseModel, EmailStr
import uuid
from ..models.user import UserStatus

class RegisterRequest(BaseModel):
    email: EmailStr
    name: str
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

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


class AdminUserResponse(UserResponse):
    """Admin-scoped user view. Extends UserResponse with the invite token,
    which is a credential — it must never be exposed to non-admin callers
    (see SECURITY_AUDIT C1: any-authenticated-user endpoints that returned
    UserResponse leaked invite tokens, enabling account takeover via
    /auth/accept-invite)."""
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
    password: str

# Invite flow
class AcceptInviteRequest(BaseModel):
    token: str
    password: str

class InviteInfoResponse(BaseModel):
    email: str
    name: str
    org_name: str | None = None

class UpdateProfileRequest(BaseModel):
    name: str | None = None
    avatar_url: str | None = None

class UpdateUserRoleRequest(BaseModel):
    is_admin: bool

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID

