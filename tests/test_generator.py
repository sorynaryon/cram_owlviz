"""Tests for generator/cram_ontology.py on a miniature repository (tests/generator_fixture). Run: python -m unittest discover tests"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generator"))

import cram_ontology  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "generator_fixture"
DEMO = cram_ontology.BASE + "demo#"


class GeneratorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        files = cram_ontology.read_checkout(FIXTURE)
        cls.paths = sorted(files)
        cls.turtle, summary = cram_ontology.generate(files, "someone/fork", "feature", "abc123", "2026-01-01T00:00:00Z")
        cls.summary = json.loads(summary)

    def block(self, local: str) -> str:
        match = re.search(rf"^demo:{re.escape(local)}\n(.*?) \.\n", self.turtle, re.M | re.S)
        self.assertIsNotNone(match, f"demo:{local} is not in the output")
        return match.group(1)

    def test_module_names_follow_src_layout(self):
        self.assertEqual(cram_ontology.module_name("demo/src/demo/world/entities.py"), "demo.world.entities")
        self.assertEqual(cram_ontology.module_name("demo/src/demo/__init__.py"), "demo")
        self.assertIsNone(cram_ontology.module_name("demo/tests/test_ignored.py"))
        self.assertIsNone(cram_ontology.module_name("setup.py"))

    def test_selected_files(self):
        self.assertEqual(self.paths, ["demo/pyproject.toml", "demo/src/demo/__init__.py", "demo/src/demo/world/__init__.py",
                                      "demo/src/demo/world/annotations.py", "demo/src/demo/world/entities.py"])

    def test_class_with_docstring_and_source_link(self):
        body = self.block("Body")
        self.assertIn('rdfs:comment "Represents a body in the world."', body)
        self.assertIn("https://github.com/someone/fork/blob/abc123/demo/src/demo/world/entities.py#L", body)

    def test_first_docstring_paragraph_only(self):
        self.assertIn('rdfs:comment "Anything in the world."', self.block("WorldEntity"))

    def test_private_base_is_skipped_but_inherited_through(self):
        self.assertNotIn("demo:_Helper", self.turtle)
        self.assertIn("rdfs:subClassOf demo:WorldEntity", self.block("Body"))

    def test_bases_resolved_through_reexports_and_module_aliases(self):
        self.assertIn("rdfs:subClassOf demo:Body", self.block("Handle"))
        self.assertIn("rdfs:subClassOf demo:Body", self.block("Drawer"))

    def test_abstract_class(self):
        self.assertIn('cram:abstract "true"^^xsd:boolean', self.block("WorldEntity"))

    def test_field_restrictions(self):
        body = self.block("Body")
        self.assertIn("owl:onProperty demo:parent ; owl:maxQualifiedCardinality \"1\"^^xsd:nonNegativeInteger ; owl:onClass demo:Body", body)
        self.assertIn("owl:onProperty demo:children ; owl:allValuesFrom demo:Body", body)
        self.assertIn("owl:onProperty demo:color ; owl:qualifiedCardinality \"1\"^^xsd:nonNegativeInteger ; owl:onClass demo:Color", body)
        self.assertIn("owl:onProperty demo:mesh ; owl:qualifiedCardinality \"1\"^^xsd:nonNegativeInteger ; owl:onClass ext:numpy.ndarray", body)
        self.assertNotIn("demo:anything ; owl:qualifiedCardinality \"1\"^^xsd:nonNegativeInteger ; owl:on", body)

    def test_inherited_field_keeps_one_property(self):
        self.assertIn("owl:onProperty demo:name ; owl:qualifiedCardinality \"1\"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:string", self.block("WorldEntity"))
        self.assertIn("owl:onProperty demo:name ; owl:qualifiedCardinality \"1\"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:integer", self.block("Drawer"))
        self.assertIn('demo:name\n    a owl:DatatypeProperty ;\n    rdfs:label "name" ;\n    rdfs:comment "The unique name of the entity."', self.turtle)

    def test_class_variables_and_private_fields_are_not_properties(self):
        self.assertNotIn("demo:registry", self.turtle)
        self.assertNotIn("demo:_cache", self.turtle)

    def test_enum_members_are_individuals(self):
        self.assertIn("rdfs:subClassOf ext:enum.Enum", self.block("Color"))
        self.assertIn('demo:Color.RED\n    a owl:NamedIndividual ;\n    a demo:Color ;\n    rdfs:label "RED"', self.turtle)

    def test_external_classes_below_one_root(self):
        self.assertIn('ext:numpy.ndarray\n    a owl:Class ;\n    rdfs:label "ndarray" ;\n    rdfs:subClassOf ext:ExternalClass', self.turtle)

    def test_tests_are_ignored(self):
        self.assertNotIn("IgnoredBecauseTest", self.turtle)

    def test_summary(self):
        self.assertEqual(self.summary["repository"], "someone/fork")
        self.assertEqual(self.summary["commit"], "abc123")
        self.assertEqual(self.summary["statistics"]["classes"], 5)
        self.assertEqual(self.summary["statistics"]["individuals"], 2)
        self.assertEqual(self.summary["problems"], [])

    def test_package_description_from_pyproject(self):
        self.assertIn('rdfs:comment "A miniature CRAM-like package for the generator tests."', self.turtle)


if __name__ == "__main__":
    unittest.main()
