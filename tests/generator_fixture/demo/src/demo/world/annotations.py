from demo import Body
from demo.world import entities as ent


class Handle(Body):
    """A graspable part."""


class Drawer(ent.Body):
    handle: Handle
    name: int
