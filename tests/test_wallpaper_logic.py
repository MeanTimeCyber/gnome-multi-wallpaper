import unittest


def choose_wallpaper_assignments(screen_list, wallpaper_entries):
    assignments = []
    used = set()
    valid_entries = [entry for entry in wallpaper_entries if entry and isinstance(entry.get('path'), str)]

    for screen in screen_list:
        if not screen:
            continue

        pool = [entry for entry in valid_entries if entry['orientation'] == screen['orientation']]
        if not pool:
            pool = [entry for entry in valid_entries if entry['orientation'] != screen['orientation']]
        if not pool:
            pool = valid_entries

        usable = [entry for entry in pool if entry['path'] not in used]
        ordered = usable if usable else pool
        ordered.sort(key=lambda entry: (entry['area'], entry['width'] * entry['height']), reverse=True)

        if not ordered:
            continue

        selected = ordered[0]
        assignments.append({
            'screen': screen,
            'path': selected['path'],
            'orientation': selected['orientation'],
        })
        used.add(selected['path'])

    return assignments


class WallpaperSelectionTests(unittest.TestCase):
    def test_prefers_matching_orientation(self):
        screens = [{'id': 0, 'orientation': 'landscape'}]
        wallpapers = [
            {'path': '/a/portrait1.jpg', 'orientation': 'portrait', 'area': 2000, 'width': 1200, 'height': 1600},
            {'path': '/a/landscape1.jpg', 'orientation': 'landscape', 'area': 3000, 'width': 2000, 'height': 1200},
        ]

        result = choose_wallpaper_assignments(screens, wallpapers)
        self.assertEqual(result[0]['path'], '/a/landscape1.jpg')

    def test_falls_back_when_matching_orientation_missing(self):
        screens = [{'id': 0, 'orientation': 'portrait'}]
        wallpapers = [
            {'path': '/a/landscape1.jpg', 'orientation': 'landscape', 'area': 3000, 'width': 2000, 'height': 1200},
        ]

        result = choose_wallpaper_assignments(screens, wallpapers)
        self.assertEqual(result[0]['path'], '/a/landscape1.jpg')

    def test_reuses_fewer_images_without_duplicate_path(self):
        screens = [{'id': 0, 'orientation': 'landscape'}, {'id': 1, 'orientation': 'landscape'}]
        wallpapers = [
            {'path': '/a/landscape1.jpg', 'orientation': 'landscape', 'area': 4000, 'width': 2000, 'height': 1500},
        ]

        result = choose_wallpaper_assignments(screens, wallpapers)
        self.assertEqual(len(result), 2)
        self.assertTrue(all(item['path'] == '/a/landscape1.jpg' for item in result))


if __name__ == '__main__':
    unittest.main()
