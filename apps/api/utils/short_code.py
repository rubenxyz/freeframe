import secrets
import string

ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 4


def generate_short_code(length: int = CODE_LENGTH) -> str:
    return ''.join(secrets.choice(ALPHABET) for _ in range(length))
