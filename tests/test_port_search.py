from backend.services.port_search import search_ports

def test_search_english_name():
    results = search_ports("Busan")
    assert len(results) >= 1
    assert results[0]["name"] == "Busan"
    assert "lat" in results[0]
    assert "lng" in results[0]

def test_search_korean_name():
    results = search_ports("부산")
    assert len(results) >= 1
    assert results[0]["name"] == "Busan"

def test_search_partial_match():
    results = search_ports("sing")
    names = [r["name"] for r in results]
    assert any("Singapore" in n for n in names)

def test_search_no_results():
    results = search_ports("xyznonexistent")
    assert results == []

def test_search_max_results():
    results = search_ports("port")
    assert len(results) <= 10

def test_search_case_insensitive():
    results = search_ports("busan")
    assert len(results) >= 1
    assert results[0]["name"] == "Busan"
