"""Generic validation policy for generated models; no engineering definitions."""

from pydantic import BaseModel, ConfigDict


class ContractModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, validate_default=True)
