from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import ClassVar, Dict, List, Optional, TypeVar

T = TypeVar("T")


class Color(Enum):
    """Colours of bodies."""

    RED = 1
    GREEN = 2


@dataclass
class WorldEntity(ABC):
    """Anything in the world.

    Second paragraph that is not used.
    """

    name: str
    """The unique name of the entity."""
    registry: ClassVar[Dict[str, WorldEntity]] = {}
    _cache: int = 0

    @abstractmethod
    def describe(self) -> str: ...


@dataclass
class _Helper(WorldEntity):
    weight: float = 0.0


@dataclass
class Body(_Helper):
    """Represents a body in the world."""

    parent: Optional[Body] = None
    children: List["Body"] = field(default_factory=list)
    color: Color = Color.RED
    mesh: "numpy.ndarray" = None
    anything: T = None

    def describe(self) -> str:
        return self.name
